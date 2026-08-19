-- =====================================================================
-- 0035 — Ashby invite delivery: PREREQUISITE-GATED claim, attempt-safe
--        DEFERRAL, audited reopen, and a truthful stuck/blocked surface.
--
-- Forward-only and additive (C-1): CREATE OR REPLACE of one existing
-- function with an UNCHANGED signature, three NEW functions, and one column
-- comment. No table is created, dropped, or retyped; no column is dropped;
-- no constraint is widened or relaxed; no data is deleted; no browser-role
-- grant or policy is added anywhere.
--
-- Security posture (mirrors 0029/0030/0031/0032/0033/0034): every SECURITY
-- DEFINER RPC pins search_path, is revoked from public/anon/authenticated,
-- and is granted to service_role only. Nothing here returns a resume file
-- handle, a presigned URL, an invite token, or any candidate field.
--
-- WHY THIS MIGRATION EXISTS (live synthetic canary + independent audit):
--
--   B-1  THE INVITE CHARGED A *WAIT* AGAINST ITS *FAILURE* BUDGET. This is
--        the defect that fires on the HEALTHY path, and it is the reason the
--        canary's invite died. Three facts compose it:
--          (i)   `claim_ashby_operation` increments `attempts` at claim time,
--                so a claim that discovers "not ready yet" and does no work
--                has already spent an attempt;
--          (ii)  `fail_ashby_operation` applies NO backoff on retry
--                (`scheduled_at = p_now`), and the claim orders by
--                `scheduled_at, id` — so the operation goes straight back to
--                the head of the queue;
--          (iii) the worker passed `ingestion_not_ready` as retryable.
--        With `max_attempts = 5` and a 5-second operation poll, an
--        `invite_delivery` therefore PERMANENTLY FAILS ~20-25 seconds after
--        import unless the resume download + malware scan + parse all
--        complete inside that window. The attempt bound was designed as a
--        safety property; it functioned as a deadline.
--
--        The repair has two halves, and BOTH are required:
--
--        (a) Prerequisites become part of what RUNNABLE means, in the claim
--            RPC itself, so a blocked operation is never selected: it stays
--            `pending`, is charged no attempt, and becomes claimable the
--            moment its prerequisite is satisfied. No wake-up plumbing and
--            no polling storm — the operation loop already polls, and the
--            predicate flips on its own.
--
--        (b) `defer_ashby_operation` handles the POST-CLAIM race (a mapping
--            paused, or an ingestion that changed state, between claim and
--            execution). A deferral is NOT a failure: it refunds the attempt
--            the claim charged, records a sanitized reason, and reschedules
--            behind a server-clamped delay. Without (b) the same budget
--            exhaustion recurs — just more rarely, and therefore more
--            confusingly.
--
--        Why a SEPARATE function rather than a parameter on
--        `fail_ashby_operation`: `create or replace function` with a changed
--        signature creates a SECOND overload rather than replacing, and
--        PostgREST may resolve to either. Keeping `fail` at its existing
--        signature and adding `defer` also keeps the semantics unambiguous —
--        `fail` means failed, `defer` means not-yet.
--
--   B-2  NO INGESTION-READINESS PREREQUISITE EXISTED. The claim RPC's
--        dependency mechanism is operation -> operation only
--        (`depends_on_operation_id`); there was no way to express "this
--        invite depends on that ingestion", so the readiness check lived in
--        application code, AFTER the claim had already incremented attempts.
--        The mapping-enabled check had the identical shape: a mapping paused
--        for longer than ~25 seconds permanently failed every in-flight
--        invite. Both are now claim prerequisites.
--
--   F-2  NO-RESUME DEADLOCK (found while implementing B-2). `runImport` seeds
--        an ingestion row for EVERY link, including an application that
--        carried no resume file handle at all. The worker's "is this
--        application resume-backed?" test was "does an ingestion row exist?",
--        which is therefore ALWAYS true — so a no-resume application would
--        wait forever for an ingestion that had nothing to ingest. Both the
--        predicate here and the worker now key on the link's
--        `external_resume_file_handle`, which is the actual fact. (This is a
--        deliberate divergence from the audit's suggested "no ingestion row
--        exists" test, which the import path makes unreachable.)
--
--   R-1  RECOVERY. Operations already driven to `failed` with
--        attempts = max_attempts by B-1 cannot be rescued by any existing
--        primitive, and this was verified rather than assumed:
--          * `retry_ashby_operation` refuses with `retry_exhausted` at
--            `attempts >= max_attempts` — a correct guard that must not be
--            weakened;
--          * re-enqueueing is a no-op: `inviteDeliveryOperationKey` fixes the
--            key at import time with the literal `inviteId = 'pending'`, and
--            `enqueue_ashby_operation` is `on conflict do nothing`;
--          * a direct UPDATE bypasses the audit trail and every guard.
--        `reopen_ashby_invite_delivery` is therefore the narrow, audited
--        escape hatch. Its sixth guard — the DEFERRAL-CODE ALLOWLIST — is
--        what keeps it from becoming a general-purpose budget reset: only an
--        operation that failed for a PREREQUISITE reason is reopenable, never
--        one that failed for a real delivery reason (`blocked_provider`,
--        `invalid_reissue_path`). Resetting `attempts` under that guard is a
--        correction of a MIS-ACCOUNTING (those attempts were deferrals, not
--        failures), not a relaxation of a safety control: `max_attempts` is
--        never modified and no global bound moves.
--
--   H-1  A BLOCKED OR STUCK ROW WAS INVISIBLE. A prerequisite-gated operation
--        counts as `operationsPending` forever with nothing saying why, and a
--        stranded `queued` ingestion had no health signal of any kind — so a
--        failure of this shape was discoverable only by direct DB inspection.
--        `ashby_prerequisite_backlog` reports both, as counters only.
--
-- NOTE ON THE FILE-HANDLE BOUND: the durable contract is
-- `chk_ashby_application_links_resume_handle` = 1..512 from 0029, and it is
-- deliberately NOT changed here. 512 is already the bound honoured by the
-- resume-handle extractor; only the API client disagreed (it applied the
-- generic id bound of 256 to an opaque provider token, which is what rejected
-- the canary's 270-character handle pre-transport). The client is corrected to
-- 512 in code. Raising the durable column instead would let the extractor hand
-- an over-long handle to `createLink` and convert a clean pre-transport refusal
-- into a mid-import constraint violation. If a future tenant ever produces a
-- longer handle, all THREE — client, extractor, and this CHECK — must move in
-- the same change, never independently.
-- =====================================================================

comment on column screening_v2.ashby_application_links.external_resume_file_handle is
  'Opaque Ashby file handle reference only — never resume bytes or a signed '
  'URL. Bounded 1..512 by chk_ashby_application_links_resume_handle. That 512 '
  'is ONE cross-layer contract, mirrored by MAX_FILE_HANDLE_LEN in the Ashby '
  'client and by extractResumeHandle; a handle is a provider TOKEN, not an id, '
  'so the generic 256 id bound must never be applied to it. Change all three '
  'together or none.';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. claim_ashby_operation — prerequisites are part of RUNNABLE
-- ═══════════════════════════════════════════════════════════════════════
-- Unchanged signature and unchanged result shape. The ONLY change is the
-- added prerequisite predicate for `invite_delivery`:
--
--   (a) the application link is not terminal            (already true in 0032)
--   (b) the link's job mapping is ENABLED
--   (c) if the link is RESUME-BACKED (external_resume_file_handle is not
--       null) its resume ingestion row exists and is `ready`
--
-- An operation failing (b) or (c) is not selected at all. It is NOT failed,
-- NOT rescheduled and NOT charged an attempt — it simply is not yet runnable,
-- exactly like a `stage_move` whose `scorecard_write` dependency has not
-- succeeded. `scorecard_write` and `stage_move` are unaffected, and
-- `awaiting_manual_delivery` remains unclaimable (the state filter is still
-- `state = 'pending'`).
--
-- Index note: the (c) probe is by `application_link_id`, which is served by
-- the 0029 UNIQUE constraint `uq_ashby_resume_ingestions_link` — verified,
-- not assumed. No new index is added: a sequential scan inside a
-- `FOR UPDATE SKIP LOCKED` claim would be a lock-duration problem, and there
-- is none. The (b) probe is by mapping primary key.

create or replace function screening_v2.claim_ashby_operation(
  p_operation_type text,
  p_owner          text,
  p_lease_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_op    screening_v2.ashby_operations%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 30), 1), 900);
  v_token uuid := gen_random_uuid();
begin
  if p_operation_type is not null
     and p_operation_type not in ('invite_delivery','scorecard_write','stage_move') then
    return jsonb_build_object('status', 'invalid_operation_type');
  end if;

  select o.* into v_op
    from screening_v2.ashby_operations o
    join screening_v2.ashby_application_links l on l.id = o.application_link_id
   where o.provider = 'ashby'
     and o.state = 'pending'
     and o.scheduled_at <= p_now
     and l.terminal_state is null
     and (p_operation_type is null or o.operation_type = p_operation_type)
     and (o.lease_expires_at is null or o.lease_expires_at <= p_now)
     and (
       o.depends_on_operation_id is null
       or exists (
         select 1 from screening_v2.ashby_operations d
          where d.id = o.depends_on_operation_id and d.state = 'succeeded'
       )
     )
     -- ── 0035 prerequisite gate for invite delivery ────────────────────
     and (
       o.operation_type <> 'invite_delivery'
       or (
         -- (b) an ENABLED mapping is what authorizes contacting a candidate.
         exists (
           select 1 from screening_v2.ashby_job_mappings m
            where m.id = l.job_mapping_id and m.status = 'enabled'
         )
         -- (c) a resume-backed link waits for its OWN ingestion to be ready.
         and (
           l.external_resume_file_handle is null
           or exists (
             select 1 from screening_v2.ashby_resume_ingestions i
              where i.application_link_id = l.id and i.state = 'ready'
           )
         )
       )
     )
   order by o.scheduled_at, o.id
   for update of o skip locked
   limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  update screening_v2.ashby_operations
     set state = 'running',
         attempts = attempts + 1,
         lease_token = v_token,
         lease_owner = left(coalesce(p_owner, 'worker'), 128),
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where id = v_op.id;

  return jsonb_build_object(
    'status', 'claimed',
    'id', v_op.id,
    'operation_type', v_op.operation_type,
    'operation_key', v_op.operation_key,
    'application_link_id', v_op.application_link_id,
    'lease_token', v_token,
    'attempts', v_op.attempts + 1,
    'max_attempts', v_op.max_attempts,
    'marker', v_op.marker
  );
end;
$$;

revoke all on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_ashby_operation is
  'Leased claim (FOR UPDATE SKIP LOCKED) of the next RUNNABLE pending Ashby '
  'operation. 0032: terminal links are never claimed and the result carries '
  'operation_key. 0035: an invite_delivery is runnable only when its mapping '
  'is ENABLED and — for a resume-backed link — its resume ingestion is ready. '
  'An operation whose prerequisites are unmet is not selected, so waiting is '
  'never charged against its failure budget. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. defer_ashby_operation — attempt-REFUNDING return to pending
-- ═══════════════════════════════════════════════════════════════════════
-- The post-claim race backstop. `fail_ashby_operation(retryable => true)`
-- leaves the claim's attempt spent and reschedules with NO backoff, which is
-- exactly how the canary's budget was burned. This RPC instead CAS's on the
-- live lease, returns the row to `pending`, REFUNDS the attempt the claim
-- charged, and reschedules behind a server-clamped delay (1..3600s) so a
-- persistent prerequisite gap costs one bounded poll per window rather than a
-- hot loop. It can never mark anything failed, succeeded, or cancelled, and
-- it never raises `max_attempts`.

create or replace function screening_v2.defer_ashby_operation(
  p_operation_id  uuid,
  p_lease_token   uuid,
  p_reason_code   text,
  p_delay_seconds integer default 60,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_delay   integer := least(greatest(coalesce(p_delay_seconds, 60), 1), 3600);
  v_updated integer := 0;
  v_op_id   uuid;
  v_link    uuid;
  v_att     integer;
begin
  if p_reason_code is not null and p_reason_code !~ '^[a-z0-9_.:-]{1,64}$' then
    return jsonb_build_object('status', 'invalid_error_code');
  end if;

  update screening_v2.ashby_operations
     set state = 'pending',
         -- Refund: the claim charged an attempt for work that never ran.
         attempts = greatest(attempts - 1, 0),
         lease_token = null,
         lease_owner = null,
         lease_expires_at = null,
         error_code = p_reason_code,
         last_error_at = p_now,
         scheduled_at = p_now + make_interval(secs => v_delay),
         updated_at = p_now
   where id = p_operation_id
     and provider = 'ashby'
     and state = 'running'
     and lease_token = p_lease_token
     and (lease_expires_at is null or lease_expires_at > p_now)
  returning id, application_link_id, attempts into v_op_id, v_link, v_att;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return jsonb_build_object('status', 'not_owned');
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-4000-8000-000000000001', 'system',
     'ashby_operation_update', 'ashby_operation', v_op_id::text, 'success',
     jsonb_build_object('operation_id', v_op_id,
                        'application_link_id', v_link,
                        'outcome', 'deferred',
                        'error_code', p_reason_code,
                        'attempts', v_att,
                        'delay_seconds', v_delay));

  return jsonb_build_object('status', 'ok', 'outcome', 'deferred',
                            'attempts', v_att, 'delay_seconds', v_delay);
end;
$$;

revoke all on function screening_v2.defer_ashby_operation(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.defer_ashby_operation(uuid, uuid, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.defer_ashby_operation is
  'CAS (under the live lease) DEFERRAL of a RUNNING Ashby operation back to '
  'pending because a prerequisite stopped holding after the claim. Refunds '
  'the attempt the claim charged and reschedules behind a clamped delay '
  '(1..3600s). A deferral is not a failure: it never marks the operation '
  'failed/succeeded/cancelled and never raises max_attempts. Audited. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. reopen_ashby_invite_delivery — guarded, audited operator recovery
-- ═══════════════════════════════════════════════════════════════════════
-- For operations ALREADY driven to failed/attempts-exhausted by the ordering
-- defect. Deliberately NOT a general "unfail" primitive. Guards, in order:
--
--   1. the row exists, provider='ashby', operation_type='invite_delivery' —
--      NEVER scorecard_write or stage_move (the result-sink refusal
--      documented in operation-worker.ts must hold at the DB layer too);
--   2. state = 'failed';
--   3. the application link is non-terminal (resurrection guard);
--   4. the link's mapping is still ENABLED — a paused mapping is exactly the
--      state in which reopening is wrong (retry_ashby_operation does not
--      check this; this RPC must);
--   5. the ingestion prerequisite genuinely holds — a resume-backed link's
--      ingestion is `ready`;
--   6. the recorded error_code is in the DEFERRAL-CODE ALLOWLIST. This is the
--      guard that keeps the RPC from being a back door around max_attempts
--      for every failure class.
--
-- Keyed by OPERATION id, not by link, so an operator reopens exactly the row
-- they inspected. `max_attempts` is never modified; attempts are reset for
-- that one row only, and the audit records the PRE-RESET attempts, the
-- error_code that justified the reset, and the acting admin.

create or replace function screening_v2.reopen_ashby_invite_delivery(
  p_operation_id uuid,
  p_actor_id     uuid,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_op        screening_v2.ashby_operations%rowtype;
  v_link      screening_v2.ashby_application_links%rowtype;
  v_mapping   text;
  v_ingestion text;
  -- The ONLY codes a prerequisite deferral can leave behind. A delivery that
  -- failed for a real delivery reason is not in this set and is not reopenable.
  v_deferral_codes constant text[] := array['ingestion_not_ready','mapping_inactive'];
begin
  select * into v_op
    from screening_v2.ashby_operations
   where id = p_operation_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_op.operation_type <> 'invite_delivery' then
    return jsonb_build_object('status', 'unsupported_operation_type',
                              'operation_type', v_op.operation_type);
  end if;

  if v_op.state <> 'failed' then
    return jsonb_build_object('status', 'not_retryable', 'state', v_op.state);
  end if;

  select * into v_link
    from screening_v2.ashby_application_links
   where id = v_op.application_link_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  select m.status into v_mapping
    from screening_v2.ashby_job_mappings m
   where m.id = v_link.job_mapping_id;
  if v_mapping is distinct from 'enabled' then
    return jsonb_build_object('status', 'blocked_mapping',
                              'mapping_status', coalesce(v_mapping, 'missing'));
  end if;

  if v_link.external_resume_file_handle is not null then
    select i.state into v_ingestion
      from screening_v2.ashby_resume_ingestions i
     where i.application_link_id = v_link.id;
    if v_ingestion is distinct from 'ready' then
      return jsonb_build_object('status', 'ingestion_not_ready',
                                'ingestion_state', coalesce(v_ingestion, 'missing'));
    end if;
  end if;

  if v_op.error_code is null or not (v_op.error_code = any(v_deferral_codes)) then
    return jsonb_build_object('status', 'not_a_deferral',
                              'error_code', coalesce(v_op.error_code, 'null'));
  end if;

  update screening_v2.ashby_operations
     set state = 'pending',
         -- Correction of a MIS-ACCOUNTING: those attempts were deferrals
         -- booked against the failure budget by the ordering defect. Strictly
         -- safer than raising max_attempts, which would permanently enlarge
         -- the budget for genuine failures too.
         attempts = 0,
         scheduled_at = p_now,
         error_code = null,
         error_detail = null,
         lease_token = null,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = p_now
   where id = p_operation_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     -- 'recruiter' is the actor_type the 0007 CHECK allows for a human
     -- operator ('admin' is not a member of that set); the ADMIN identity is
     -- carried by actor_id, which is what makes the reopen attributable.
     'recruiter',
     'ashby_operation_retry', 'ashby_operation', p_operation_id::text, 'success',
     jsonb_build_object('operation_id', p_operation_id,
                        'application_link_id', v_op.application_link_id,
                        'operation_type', v_op.operation_type,
                        'reason', 'prerequisite_ordering',
                        'reopened_error_code', v_op.error_code,
                        'attempts_before', v_op.attempts,
                        'max_attempts', v_op.max_attempts));

  return jsonb_build_object('status', 'ok',
                            'attempts_before', v_op.attempts,
                            'max_attempts', v_op.max_attempts);
end;
$$;

revoke all on function screening_v2.reopen_ashby_invite_delivery(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reopen_ashby_invite_delivery(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.reopen_ashby_invite_delivery is
  'Audited operator reopen of ONE invite_delivery operation that FAILED on a '
  'prerequisite-deferral code (ingestion_not_ready / mapping_inactive). '
  'Refuses on a non-invite type, a non-failed state, a terminal link, a '
  'non-enabled mapping, an ingestion that is not ready, and any error_code '
  'outside the deferral allowlist. Resets attempts for that row only — '
  'max_attempts and every global bound are unchanged. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. ashby_prerequisite_backlog — "waiting, not broken" + "stuck"
-- ═══════════════════════════════════════════════════════════════════════
-- Four counters, no identifiers of any kind:
--
--   pending_blocked      invite deliveries held back by an unmet prerequisite
--                        (correct behaviour — waiting, not broken)
--   failed_prerequisite  invite deliveries already killed by the ordering
--                        defect and needing reopen_ashby_invite_delivery
--   ingestion_stuck_queued    ingestions that never started
--   ingestion_stuck_fetching  ingestions that started and never progressed
--
-- The two stuck counters are the signal that did not exist anywhere before:
-- a stranded ingestion was invisible to /health and to Mission Control by
-- construction, so a failure of this shape was discoverable only by direct
-- database inspection.

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
    )
  );
$$;

revoke all on function screening_v2.ashby_prerequisite_backlog(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.ashby_prerequisite_backlog(integer, timestamptz)
  to service_role;

comment on function screening_v2.ashby_prerequisite_backlog is
  'Four counters for the invite-ordering surface: invite deliveries waiting on '
  'an unmet prerequisite, invite deliveries already failed on a '
  'prerequisite-deferral code, and resume ingestions stranded in queued or '
  'fetching beyond a clamped age. Counters ONLY — no application, job, '
  'candidate or tenant identifier. Service-role-only.';
