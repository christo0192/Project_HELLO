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
-- construction. `scanning`, `extracting` and `structuring` are ALL fatal this
-- way; `queued` and `fetching` are not, because `queued -> fetching` is legal
-- and `fetching -> fetching` is a same-state no-op that returns ok. The two
-- states that self-heal were the two the health surface already counted
-- (`ingestion_stuck_queued`, `ingestion_stuck_fetching`) and the three that
-- deadlock had no counter at all — the monitoring was the exact complement of
-- the bug.
--
-- Bulk upload is what turns this from rare to routine: the vulnerable window
-- is the time a row spends in those three states, and one restart strands
-- EVERY row then inside it. `structuring` is the widest window (it spans the
-- model structurer) and, before this migration, the only one with no legal way
-- back at all.
--
-- This file ships the SQL half. The worker half (walk a mid-flight row back to
-- `queued` before entering, and never `return` bare on a non-ok advance) lands
-- in the same PR.
--
-- ── 1. THE `structuring -> queued` EDGE HAS TO EXIST ────────────────────
-- The trigger permitted `fetching -> queued` and `scanning -> queued` (0037,
-- abandon-before-verdict) and `extracting -> queued` (0039, parse deferral).
-- `structuring` was left out, so a row interrupted there could not be recovered
-- by ANY RPC — only by a hand-written UPDATE with the trigger disabled.
--
-- Re-driving from `structuring` is safe: the persist step resolves the SHELL
-- candidate already bound to the link and UPDATEs it (`populateExistingCandidate`),
-- so a second pass repopulates the same row rather than creating a duplicate.
--
-- Following the established pattern exactly: the trigger permits the edge, and
-- `advance_ashby_ingestion` REFUSES it on the generic path, so a redelivered
-- webhook or a reconciliation re-observation still cannot walk it. Only the
-- audited RPC below may.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.enforce_ashby_ingestion_transition()
returns trigger language plpgsql set search_path = pg_catalog as $$
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
    -- 0097: also through resume_ashby_ingestion_midflight, for a run that DIED
    -- here. `advance_ashby_ingestion` refuses this edge; see below.
    when 'extracting'  then allowed := array['structuring','failed_review','cancelled','queued'];
    -- 0097: 'queued' is reachable ONLY through resume_ashby_ingestion_midflight
    -- — the process died between the parse and the durable `ready`, so nothing
    -- was concluded about the document and re-driving repopulates the same
    -- bound shell. `advance_ashby_ingestion` refuses this edge on the generic
    -- path, so a redelivered webhook can never re-download a resume that is
    -- mid-structure.
    when 'structuring' then allowed := array['ready','failed_review','cancelled','queued'];
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

-- ── 2. THE GENERIC PATH REFUSES THE NEW EDGE ────────────────────────────
-- Byte-for-byte the 0084 body plus ONE refusal: `structuring`. Recreated in
-- full rather than patched, because a partial redefinition of a SECURITY
-- DEFINER function is how an unnoticed privilege or search_path drift ships.
create or replace function screening_v2.advance_ashby_ingestion(
  p_application_link_id uuid,
  p_next_state text,
  p_content_sha256 text,
  p_extractor_version text,
  p_structurer_version text,
  p_failed_reason text,
  p_now timestamptz default now()
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
    -- 0097: the mid-flight resume RPC is the OTHER sanctioned caller.
    if v_state = 'extracting' then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'reason', 'parse_defer_only');
    end if;

    -- 0097: the structuring -> queued edge exists for the MID-FLIGHT RESUME
    -- alone — a process that died between the parse and the durable `ready`.
    if v_state = 'structuring' then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'reason', 'midflight_recovery_only');
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

-- ── 3. THE AUDITED MID-FLIGHT RESUME ────────────────────────────────────
-- Walks a row that a dead process left in `scanning`, `extracting` or
-- `structuring` back to `queued` so the ordinary pipeline re-drives it from
-- the top.
--
-- Deliberately NOT a widening of `advance_ashby_ingestion`: that function is
-- reachable from the generic worker path, and the whole point of these three
-- edges is that only a caller which KNOWS the previous run died may take them.
--
-- The 0032 attempts ceiling is unchanged and enforced here too, so a row that
-- keeps dying mid-flight rests loudly in `failed_review` instead of looping
-- forever. Nothing about a document is concluded by this call, so the row
-- carries no failure reason forward.
create or replace function screening_v2.resume_ashby_ingestion_midflight(
  p_application_link_id uuid,
  p_reason text,
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
  v_max_attempts constant integer := 5;
  -- EXACTLY the states a dead run can strand. `queued` and `fetching` are
  -- excluded because they already self-heal (`queued -> fetching` is legal and
  -- `fetching -> fetching` is an idempotent no-op), and admitting them here
  -- would let a healthy in-flight row be yanked backwards by a concurrent
  -- worker mid-download.
  v_midflight_states constant text[] := array['scanning','extracting','structuring'];
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

  return jsonb_build_object('status', 'ok',
                            'state', 'queued',
                            'from_state', v_ing.state,
                            'attempts', v_attempts,
                            'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, timestamptz)
  to service_role;

comment on function screening_v2.resume_ashby_ingestion_midflight(uuid, text, timestamptz) is
  'Walks a resume ingestion stranded in scanning/extracting/structuring by a dead '
  'process back to queued so the pipeline re-drives it. Honours the 0032 attempts '
  'ceiling and refuses terminal applications. The ONLY sanctioned caller of the '
  'structuring -> queued edge; advance_ashby_ingestion refuses it.';

-- ── 4. THE THREE STATES THAT DEADLOCK NOW HAVE COUNTERS ─────────────────
-- The pre-0097 surface counted `queued` and `fetching` — the two states that
-- recover unaided — and nothing else. A row stranded in `scanning`,
-- `extracting` or `structuring` was invisible to /health by construction, and
-- discoverable only by reading the table by hand. That is exactly how two
-- résumés sat stuck with nobody paged.
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
    -- 0097: the three states a dead process strands a row in. A row cannot
    -- enter any of them without a resume handle, so no handle predicate is
    -- needed (the same reasoning `ingestion_stuck_fetching` already uses).
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
