-- =====================================================================
-- 0040 — Atomic queue admission for the audited ingestion parse recovery.
--
-- FORWARD-ONLY. Replaces exactly one function body
-- (`screening_v2.recover_ashby_ingestion_parse`, same signature) and
-- creates, drops and alters nothing else. No table, column, index,
-- constraint, trigger, grant or type is touched. 0039 and every earlier
-- migration stay byte-identical.
--
-- ── THE DEFECT ────────────────────────────────────────────────────────
-- 0039 shipped an operator retry that does its BOOKKEEPING and schedules
-- none of the work that bookkeeping claims to have started.
--
-- `recover_ashby_ingestion_parse` performs `failed_review -> queued`,
-- charges an attempt, and writes an audit row with `result = 'success'`.
-- It never touches `screening_v2.job_queue`, and NOTHING ELSE ENQUEUES
-- AN `ashby.ingestion` JOB FOR AN ALREADY-IMPORTED APPLICATION:
--
--   * the original `ashby.ingestion` job COMPLETED — a parse failure is a
--     normal handler return, not a throw, so there is no lease to reclaim
--     and no dead letter to replay;
--   * the only producer of `ashby.ingestion` is the `ashby.import`
--     handler, whose only producer is an `ashby.signal` job, whose only
--     producer is the 0030 transactional outbox in
--     `record_ashby_event_receipt`;
--   * that outbox SUPPRESSES re-drive on a receipt already in a terminal
--     status (0030: `if v_status in ('processed','ignored','failed')`).
--     The already-imported application's receipt IS `processed`, and an
--     UNCHANGED application mints no new receipt — reconciliation keys on
--     (application, stage) and a webhook redelivery keys on the same
--     provider action id, so both re-observe the same terminal receipt
--     and decline, every pass, forever;
--   * no scheduler loop scans `ashby_resume_ingestions` for `queued`.
--
-- So the row rested in `queued` indefinitely, having LEFT the
-- `ingestionFailedParse` operator queue that was watching it, while the
-- audit row said the retry succeeded. Four further retries would burn the
-- remaining budget and schedule nothing, until the fifth answered
-- `retry_exhausted` — a row now permanently unrecoverable through the
-- audited door, never once re-parsed.
--
-- ── THE INVARIANT ─────────────────────────────────────────────────────
-- The signal worker states it in its own words: a scheduling failure must
-- never leave a governing receipt terminal with no durable work, "and the
-- reconciliation re-drive would then decline to re-enqueue". Generalised:
--
--   ANY transition into a non-terminal, WORK-OWING state must, in the
--   SAME TRANSACTION, guarantee a live job or an unsuppressed re-drive.
--
-- 0039 guaranteed neither. 0040 guarantees the first.
--
-- ── WHY INSIDE THE RPC ────────────────────────────────────────────────
-- Enqueuing from the route or the store AFTER the RPC returns would fix
-- the visible symptom and INTRODUCE the exact hole 0030 was written to
-- close: a committed state transition whose enqueue then fails leaves
-- `queued` durable with no work and no re-drive — worse than today,
-- because the operator queue has already been left. The insert therefore
-- shares the RPC's transaction: if it cannot be made durable, the state
-- change, the attempt charge and the audit row all roll back and the row
-- stays truthfully in `failed_review`.
--
-- This is the house pattern twice over: `record_ashby_event_receipt`
-- (0030) and `enqueue_recording_finalize` (0038) both enqueue inside the
-- transaction that owes the work.
--
-- The REJECTED alternative — a fifth scheduler loop sweeping `queued`
-- ingestions — would work, but adds a polling surface needing its own
-- admission cap and stuck-window tuning to avoid re-creating the PR #64
-- storm, and repairs the symptom for every producer instead of closing
-- the one hole that opened.
--
-- ── LOCK ORDERING ─────────────────────────────────────────────────────
-- 0039 read the link WITHOUT `for update`, so a terminal cancel
-- committing between the check and the update could leave `queued` on a
-- terminal link. That was tolerable while the transition scheduled
-- nothing; it is not tolerable now that the same transaction admits a
-- job. The link is therefore locked — and locked FIRST, matching
-- `cancel_ashby_application` (0031), which takes the link `for update`
-- and only then updates the operations and the ingestion. Same order in
-- both directions, so no deadlock-prone inversion exists. Every other
-- `for update` on an ingestion row (0033/0035/0036/0039) takes no link
-- lock at all and cannot close a cycle.
--
-- The REFUSAL ORDER of the 0039 contract is preserved exactly — locking
-- earlier must not change a single answer this function gives. The link
-- is locked before the ingestion is read, but is EVALUATED in its
-- original position, after the `failed_review` check.
-- =====================================================================

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
  v_ing        screening_v2.ashby_resume_ingestions%rowtype;
  v_link       screening_v2.ashby_application_links%rowtype;
  v_link_found boolean;
  v_attempts   integer;
  v_job_id     uuid;
  v_dedup_key  text;
  v_max_attempts constant integer := 5;
  -- Queue admission constants. These MIRROR the ordinary ingestion
  -- enqueue in `runtime-workers.ts` exactly — same queue name, same
  -- camelCase payload the handler reads, same dedup key builder
  -- (`ingestionDedupKey`), same 5 job attempts, same default priority,
  -- claimable immediately. A recovered ingestion must be
  -- INDISTINGUISHABLE from a freshly imported one once it is on the
  -- queue; anything else is a second code path to keep in step.
  v_queue_name       constant text    := 'ashby.ingestion';
  v_job_max_attempts constant integer := 5;
  v_job_priority     constant integer := 0;
  -- STABLE reasons that describe OUR MACHINE rather than the document, plus
  -- the legacy generic code that describes nothing at all and exists only to
  -- be reclassified. Membership is a NECESSARY condition for the retry, never
  -- a sufficient one — the operator supplies the judgement, which is why this
  -- is an attributable audited RPC and not an automatic behaviour.
  --
  -- UNCHANGED from 0039. Reproduced because a function body cannot be
  -- patched in place; every element and every exclusion is identical.
  v_recoverable_reasons constant text[] := array[
    'parse_timeout',
    'parse_overload',
    'parse_spawn_error',
    'parse_child_exit',
    'parse_asset_missing',
    'parse_defer_deadline',
    'parse_defer_exhausted',
    'parse_defer_unavailable',
    -- The wall-clock bound became uncomputable (an unparseable job timestamp).
    -- The wait was stopped rather than left unbounded; nothing was learned
    -- about the document, so the row is recoverable.
    'parse_defer_clock_invalid',
    -- The parse SUCCEEDED and the approved candidate/resume rows could not be
    -- written. Machine-class by construction: the document is fine, so
    -- re-running the ingestion is the correct recovery.
    'materialize_failed',
    -- Legacy: written before failures were sub-classified. One bounded retry
    -- is what turns an unfalsifiable row into a named one.
    'parse_error'
  ];
begin
  -- LOCK THE LINK FIRST — see the lock-ordering note above. Read into a
  -- separate found flag so the refusal order below stays exactly what
  -- 0039 promised.
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

  -- Only a rested row. A live ingestion's progress is the scheduler's business.
  if v_ing.state <> 'failed_review' then
    return jsonb_build_object('status', 'not_recoverable', 'state', v_ing.state);
  end if;

  if not v_link_found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Now decided under the link's own row lock: a cancel cannot commit
  -- between this check and the transition, so a terminal application can
  -- never be left `queued` and can never have a job admitted for it.
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

  v_dedup_key := 'ashby:ingestion:' || p_application_link_id::text;

  -- ── The IN-FLIGHT window, refused BEFORE anything is written ────────
  -- A job that is `active` is one a worker has already claimed. There is a
  -- narrow, real window in which such a job coexists with a `failed_review`
  -- row: the ingestion handler writes `failed_review` and only THEN returns,
  -- at which point the runner completes the job. An operator clicking retry
  -- inside that window would otherwise be told `ok` on the strength of a job
  -- that is about to complete — leaving `queued` with nothing live, which is
  -- the exact defect 0040 exists to remove.
  --
  -- It cannot be satisfied by inserting either: `uq_job_queue_dedup_active`
  -- covers `active`, so a second job for the link is impossible while that one
  -- lives. So the honest answer is a REFUSAL, given before the transition, the
  -- attempt charge or the audit row exist — nothing to roll back, no attempt
  -- spent, and the operator simply retries in a moment. The status is stable
  -- and passes through the route as a 409 like every other refusal.
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

  -- ── QUEUE ADMISSION, in this same transaction ───────────────────────
  -- `uq_job_queue_dedup_active` (0009) is a PARTIAL unique index over
  -- `pending`/`active`/`delayed` only. Three consequences, all wanted:
  --   * a COMPLETED previous job never blocks this one — exactly the retry
  --     lifecycle a recovery needs;
  --   * a still-live job converges to ONE rather than erroring;
  --   * `on conflict do nothing` (untargeted, so it covers every unique
  --     index rather than one inferred predicate) makes a duplicate
  --     admission a no-op instead of a failed recovery.
  --
  -- The payload is opaque identifiers ONLY: no file handle, no presigned
  -- URL, no invite token, no candidate field, no raw parser message. The
  -- key is `applicationLinkId` in camelCase because that is what the
  -- handler reads — snake_case would dead-letter the job as
  -- `malformed_ingestion_payload`, i.e. would trade a silent stall for a
  -- loud one instead of fixing it.
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
    -- The insert was skipped. That is only acceptable if a CLAIMABLE job
    -- for this link already exists — which is the whole point of the dedup
    -- index. Verify it rather than assume it: the contract of this
    -- function is now "returns ok ⇒ claimable work exists", and a silently
    -- skipped insert with nothing behind it would be precisely the lie
    -- 0040 exists to remove.
    --
    -- `pending` and `delayed` only. `active` is deliberately NOT accepted
    -- here: a claimed job may be seconds from completing, and the in-flight
    -- refusal above is the door for that case. Reaching this line with an
    -- `active` job means one was claimed between that check and this
    -- insert — vanishingly rare, and fail-closed rather than silently
    -- satisfied.
    select id into v_job_id
      from screening_v2.job_queue
     where name = v_queue_name
       and dedup_key = v_dedup_key
       and status in ('pending', 'delayed')
     limit 1;

    if v_job_id is null then
      -- Fail CLOSED. Aborting rolls back the transition, the attempt
      -- charge and the audit row together, so the row rests truthfully in
      -- `failed_review` with its budget intact and stays in the operator
      -- queue that is watching it. A recovery that cannot schedule work
      -- must not report that it did.
      raise exception 'ashby_ingestion_recovery_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live ashby.ingestion job could be admitted';
    end if;
  end if;

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
     -- invite token, no candidate field, no raw parser message. The audit
     -- shape is UNCHANGED from 0039 — the job id is deliberately NOT added,
     -- because no consumer reads it and every new key is a new contract.
     jsonb_build_object('application_link_id', p_application_link_id,
                        'failed_reason', v_ing.failed_reason,
                        'attempts_before', v_ing.attempts,
                        'attempts_after', v_attempts,
                        'max_attempts', v_max_attempts));

  -- The RESPONSE shape is unchanged from 0039: the route, the store and
  -- their tests keep reading exactly the keys they read before.
  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'attempts_before', v_ing.attempts,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

-- `create or replace` preserves the existing ACL; these are re-issued so the
-- service-role-only posture is pinned by THIS file too and cannot drift.
revoke all on function screening_v2.recover_ashby_ingestion_parse(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.recover_ashby_ingestion_parse(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.recover_ashby_ingestion_parse is
  'Audited, attempt-BOUNDED operator retry of ONE MACHINE-class failed_review '
  'resume ingestion. Performs the ordinary failed_review -> queued transition, '
  'CHARGES an attempt against the unchanged 5-requeue ceiling, and ADMITS the '
  'ashby.ingestion queue job in the SAME transaction — 0040. Returning ok '
  'therefore means a LIVE job exists: if none can be admitted the transition, '
  'the attempt charge and the audit row all roll back and the row rests in '
  'failed_review. It is NOT a counter reset and an exhausted row is refused '
  'with retry_exhausted. Refuses a non-failed_review row, a terminal '
  'application (decided under the link row lock, taken BEFORE the ingestion '
  'lock to match cancel_ashby_application), an ingestion job still in flight '
  '(ingestion_job_in_flight — refused before anything is written, so no '
  'attempt is spent), and every reason outside the '
  'machine-class allowlist (parse availability, an uncomputable defer clock, '
  'and a failure to write the approved candidate/resume rows); document '
  'verdicts '
  '(parse_extract_failed / parse_bad_output / parse_no_output / '
  'parse_output_exceeded / no_extractable_fields / guard_* / scan_infected) '
  'are never recoverable. Legacy generic parse_error IS allowed, once per '
  'remaining attempt, so it can be RECLASSIFIED by the sub-classifier. Issues '
  'no invite and moves no stage. Service-role-only.';
