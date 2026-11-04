-- 0134: Christy verdict tags on Ashby candidates (M027).
--
-- A new outbox operation type, `recommendation_tag`, keeps one Ashby candidate
-- tag (`Christy: Select`, `Christy: Borderline`, `Christy: Reject`) in step with
-- the newest screening verdict. It is its own row on purpose, with NO dependency
-- on `scorecard_write`:
--   * a dependency would park the tag for ever behind a failed or stranded
--     scorecard (a `running` operation has no reclaim);
--   * a newer result with no verdict has no scorecard, and the stale tag must
--     still come off;
--   * a tag failure can never resend or disturb an irretractable scorecard.
-- The worker's lane order (invite, scorecard, tag) still runs the scorecard
-- first in the normal case.
--
-- WHICH VERDICT. A tag is candidate-wide, so an operation does not apply the
-- verdict of the session it was enqueued for. Every run asks
-- `ashby_candidate_tag_verdict` for the candidate's authoritative verdict, the
-- newest assessment on any of the candidate's Ashby links, and applies that.
-- Claim order, defers, retries, the backfill and two workers at once therefore
-- all converge on the same tag: the newest verdict wins.
--
-- Additive and forward-only. complete, fail, defer, retry and cancel carry no
-- type check and need no change. `phone-screening-structural.test.ts` still
-- bars the phone lane from this table; the policy suite's I15 keeps the same
-- line: no phone type here.
--
-- Backfill: `backfill_ashby_recommendation_tags` is SHIPPED, NOT RUN. Nothing in
-- this migration enqueues a past candidate. The owner runs it by hand, dry run
-- first, after testing (docs/runbooks/ashby-runtime-activation.md section 11).

-- Fail fast rather than queue (the 0109 precedent): the CHECK swap below takes
-- ACCESS EXCLUSIVE on ashby_operations, which the worker claims from on every
-- poll tick and every enqueue and webhook writes to. A long-held lock should
-- fail this deploy (it retries cleanly), not stall the outbox behind it.
-- LOCAL: scoped to this migration's transaction, so it can never persist on a
-- pooled connection and change lock behaviour for anything after it.
set local lock_timeout = '10s';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The operation type CHECK (the 0032 chk_ashby_operations_state pattern)
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.ashby_operations
  drop constraint if exists chk_ashby_operations_type;
alter table screening_v2.ashby_operations
  add constraint chk_ashby_operations_type check (
    operation_type in ('invite_delivery','scorecard_write','stage_move','recommendation_tag')
  )
  not valid;
alter table screening_v2.ashby_operations
  validate constraint chk_ashby_operations_type;

comment on constraint chk_ashby_operations_type on screening_v2.ashby_operations is
  'Operation type allowlist, extended additively by 0134 with recommendation_tag: '
  'keep one Christy verdict tag on the Ashby candidate. Phone dialing never rides '
  'an Ashby operation type; it uses a queue name (phone.dial).';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. enqueue_ashby_operation: the 0031 body VERBATIM plus the new type
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.enqueue_ashby_operation(
  p_application_link_id uuid,
  p_operation_type      text,
  p_operation_key       text,
  p_depends_on          uuid,
  p_marker              text,
  p_actor_id            uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_application_link_id is null then
    return jsonb_build_object('status', 'invalid_link');
  end if;
  if coalesce(p_operation_type, '') not in ('invite_delivery','scorecard_write','stage_move','recommendation_tag') then
    return jsonb_build_object('status', 'invalid_operation_type');
  end if;
  if p_operation_key is null or length(p_operation_key) < 1 or length(p_operation_key) > 256 then
    return jsonb_build_object('status', 'invalid_operation_key');
  end if;
  if p_marker is not null and p_marker !~ '^[a-f0-9]{8,64}$' then
    return jsonb_build_object('status', 'invalid_marker');
  end if;

  begin
    insert into screening_v2.ashby_operations
      (application_link_id, provider, operation_type, operation_key,
       depends_on_operation_id, marker, state)
    values
      (p_application_link_id, 'ashby', p_operation_type, p_operation_key,
       p_depends_on, p_marker, 'pending')
    on conflict (provider, operation_key) do nothing
    returning id into v_id;
  exception
    when unique_violation then
      -- marker uniqueness (application_link_id, marker) — already enqueued.
      return jsonb_build_object('status', 'duplicate_marker');
    when raise_exception then
      -- The terminal-link INSERT trigger blocks new ops on a terminal link.
      return jsonb_build_object('status', 'blocked_terminal');
  end;

  if v_id is null then
    select id into v_id from screening_v2.ashby_operations
     where provider = 'ashby' and operation_key = p_operation_key;
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'), 'system',
     'ashby_operation_enqueue', 'ashby_operation', v_id::text, 'success',
     jsonb_build_object('operation_id', v_id, 'operation_type', p_operation_type,
                        'has_dependency', p_depends_on is not null));

  return jsonb_build_object('status', 'inserted', 'id', v_id);
end;
$$;

revoke all on function screening_v2.enqueue_ashby_operation(uuid, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.enqueue_ashby_operation(uuid, text, text, uuid, text, uuid)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. claim_ashby_operation: the 0059 body VERBATIM (the 0032 terminal gate and
--    the 0035 invite gate stay) plus the new type and `created_at` in the
--    answer, which the tag lane's age limit reads
-- ═══════════════════════════════════════════════════════════════════════

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
     and p_operation_type not in ('invite_delivery','scorecard_write','stage_move','recommendation_tag') then
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
    'marker', v_op.marker,
    'source_session_id', v_op.source_session_id,
    'created_at', v_op.created_at
  );
end;
$$;

revoke all on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. enqueue_ashby_recommendation_tag: one operation per assessment revision
-- ═══════════════════════════════════════════════════════════════════════
--
-- The key is `ashby:recommendation_tag:<link id>:<assessment id>`, so a rescore
-- or a re-screen gets its own operation and a re-run of the same revision is
-- idempotent. The marker is NULL: `uq_ashby_operations_marker` must not collide
-- with the scorecard's marker on the same link.
--
-- The verdict is deliberately NOT read or checked here. A newest result with no
-- verdict (or insufficient evidence) still needs an operation, because the
-- worker has to take a stale tag off. The worker reads the candidate's verdict
-- at run time (section 5), so the operation is a trigger, not a decision.

create or replace function screening_v2.enqueue_ashby_recommendation_tag(
  p_application_link_id uuid,
  p_session_id          uuid,
  p_actor_id            uuid,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link           screening_v2.ashby_application_links%rowtype;
  v_mapping_status text;
  v_assessment_id  uuid;
  v_result         jsonb;
begin
  if p_application_link_id is null or p_session_id is null
     or p_actor_id is null or p_now is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_link from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby' for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal');
  end if;

  -- A paused or drifted mapping creates no outbound operation.
  select m.status into v_mapping_status
    from screening_v2.ashby_job_mappings m
   where m.id = v_link.job_mapping_id;
  if v_mapping_status is distinct from 'enabled' then
    return jsonb_build_object('status', 'mapping_inactive');
  end if;

  if v_link.session_id is distinct from p_session_id
     and not exists (
       select 1 from screening_v2.phone_engagements e
        where e.application_link_id = p_application_link_id
          and e.session_id = p_session_id
     ) then
    return jsonb_build_object('status', 'session_mismatch');
  end if;

  select a.id into v_assessment_id
    from screening_v2.assessments a
   where a.session_id = p_session_id
   order by a.created_at desc, a.id desc
   limit 1;
  if v_assessment_id is null then
    return jsonb_build_object('status', 'assessment_missing');
  end if;

  v_result := screening_v2.enqueue_ashby_operation(
    p_application_link_id, 'recommendation_tag',
    'ashby:recommendation_tag:' || p_application_link_id::text || ':' || v_assessment_id::text,
    null, null, p_actor_id);
  if v_result->>'status' = 'inserted' then
    update screening_v2.ashby_operations
       set source_session_id = p_session_id, updated_at = p_now
     where id = (v_result->>'id')::uuid;
  end if;
  return v_result;
end;
$$;

revoke all on function screening_v2.enqueue_ashby_recommendation_tag(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.enqueue_ashby_recommendation_tag(uuid, uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.enqueue_ashby_recommendation_tag is
  'Enqueue one recommendation_tag operation for the newest assessment of a session '
  'on an Ashby link. Refuses a terminal link, a mapping that is not enabled and a '
  'session the link does not own. Idempotent per assessment revision. Service-role '
  'only; codes and opaque ids only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ashby_candidate_tag_verdict: the candidate's authoritative verdict
-- ═══════════════════════════════════════════════════════════════════════
--
-- A tag is candidate-wide, so the newest verdict has to win across every link
-- the candidate has, and it is decided when an operation RUNS, not when it was
-- enqueued. Every run recomputes this answer. So a deferred, retried or
-- concurrent older operation applies the newest verdict too, and a result that
-- never got an operation of its own (kill switch off, a failed enqueue, a
-- paused mapping) is honoured by any later operation of the same candidate.
--
-- The candidate's links: the operation's own link (whatever its state; the
-- claim and the worker already gate it), plus every OTHER non-terminal Ashby
-- link with the same Ashby candidate id (when one is given) or the same
-- non-null internal candidate. Their sessions: each link's session_id, plus
-- every phone engagement's session (one engagement per re-screen cycle). The
-- answer is the newest assessment on any of those sessions.
--
-- `no_assessment` means no result at all, so the target is "no tag".
-- Codes, counts and opaque ids only: never a name, an email or a phone.

create or replace function screening_v2.ashby_candidate_tag_verdict(
  p_application_link_id   uuid,
  p_external_candidate_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link       screening_v2.ashby_application_links%rowtype;
  v_links      uuid[];
  v_sessions   uuid[];
  v_assessment record;
begin
  if p_application_link_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_link from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby';
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  select coalesce(array_agg(l.id), '{}'::uuid[]) into v_links
    from screening_v2.ashby_application_links l
   where l.id = v_link.id
      or (l.provider = 'ashby'
          and l.terminal_state is null
          and ((p_external_candidate_id is not null
                and l.external_candidate_id = p_external_candidate_id)
               or (v_link.candidate_id is not null
                   and l.candidate_id = v_link.candidate_id)));

  select coalesce(array_agg(s.session_id), '{}'::uuid[]) into v_sessions
    from (
      select l.session_id
        from screening_v2.ashby_application_links l
       where l.id = any(v_links) and l.session_id is not null
      union
      select e.session_id
        from screening_v2.phone_engagements e
       where e.application_link_id = any(v_links) and e.session_id is not null
    ) s;

  select a.id, a.recommendation, a.evidence_grade, a.created_at
    into v_assessment
    from screening_v2.assessments a
   where a.session_id = any(v_sessions)
   order by a.created_at desc, a.id desc
   limit 1;
  if not found then
    return jsonb_build_object(
      'status', 'no_assessment',
      'link_count', cardinality(v_links),
      'session_count', cardinality(v_sessions));
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'assessment_id', v_assessment.id,
    'recommendation', v_assessment.recommendation,
    'evidence_grade', v_assessment.evidence_grade,
    'assessment_created_at', v_assessment.created_at,
    'link_count', cardinality(v_links),
    'session_count', cardinality(v_sessions));
end;
$$;

revoke all on function screening_v2.ashby_candidate_tag_verdict(uuid, text)
  from public, anon, authenticated;
grant execute on function screening_v2.ashby_candidate_tag_verdict(uuid, text)
  to service_role;

comment on function screening_v2.ashby_candidate_tag_verdict is
  'The Christy tag lane''s authoritative verdict for a candidate, read at run time: '
  'the newest assessment on the operation''s link and on every other non-terminal '
  'Ashby link of the same Ashby candidate id or internal candidate, over each '
  'link''s session and its phone engagements'' sessions. Returns the RAW '
  'recommendation and evidence grade, or no_assessment. Read-only, service-role '
  'only; codes, counts and opaque ids only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. backfill_ashby_recommendation_tags: the owner's tool. NOT RUN HERE.
-- ═══════════════════════════════════════════════════════════════════════
--
-- Eligible: an Ashby link with a SUCCEEDED scorecard_write, non-terminal, whose
-- mapping is enabled. The session is the link's newest succeeded scorecard's
-- coalesce(source_session_id, link.session_id).
--
-- A link that already has ANY recommendation_tag operation is skipped
-- (`skipped_has_tag_op`): the live lane owns it.
--
-- ORDER DOES NOT MATTER. Each operation recomputes the candidate's newest
-- verdict when it runs (section 5), so whichever runs last, the newest verdict
-- wins. Nothing here sequences the rows.
--
-- The dry run predicts the real run. It mirrors each refusal
-- enqueue_ashby_recommendation_tag would give (`skipped_session_not_owned`,
-- `skipped_no_assessment`), and counts verdicts with the very function the
-- worker runs, on the link's stored Ashby candidate id. One gap: a link with no
-- stored id is counted on its own link and internal candidate only, while the
-- worker first resolves the id from Ashby, so a sibling in another job can
-- still change the tag the real run applies to it.
--
-- A dry run writes nothing. A real run is safe to repeat: every link it
-- enqueued has a tag operation the next time, and is skipped.
-- Counts only: the Ashby candidate id is read to compute the verdict and is
-- never returned.

create or replace function screening_v2.backfill_ashby_recommendation_tags(
  p_dry_run boolean     default true,
  p_now     timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_actor constant uuid := '00000000-0000-4000-8000-000000000001';
  v_row                       record;
  v_verdict                   jsonb;
  v_status                    text;
  v_result                    jsonb;
  v_eligible                  integer := 0;
  v_advance                   integer := 0;
  v_hold                      integer := 0;
  v_reject                    integer := 0;
  v_none                      integer := 0;
  v_evidence_insufficient     integer := 0;
  v_skipped_terminal          integer := 0;
  v_skipped_mapping_inactive  integer := 0;
  v_skipped_has_tag_op        integer := 0;
  v_skipped_no_session        integer := 0;
  v_skipped_session_not_owned integer := 0;
  v_skipped_no_assessment     integer := 0;
  v_enqueue                   jsonb := '{}'::jsonb;
begin
  if p_dry_run is null or p_now is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  for v_row in
    select l.id as link_id,
           l.terminal_state,
           l.session_id as link_session_id,
           l.external_candidate_id,
           m.status as mapping_status,
           coalesce(s.source_session_id, l.session_id) as session_id
      from (
        select distinct on (o.application_link_id)
               o.application_link_id, o.source_session_id
          from screening_v2.ashby_operations o
         where o.provider = 'ashby'
           and o.operation_type = 'scorecard_write'
           and o.state = 'succeeded'
         order by o.application_link_id, o.created_at desc, o.id desc
      ) s
      join screening_v2.ashby_application_links l
        on l.id = s.application_link_id and l.provider = 'ashby'
      left join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
  loop
    if v_row.terminal_state is not null then
      v_skipped_terminal := v_skipped_terminal + 1;
      continue;
    end if;
    if v_row.mapping_status is distinct from 'enabled' then
      v_skipped_mapping_inactive := v_skipped_mapping_inactive + 1;
      continue;
    end if;
    -- The live lane owns a link that already has a tag operation.
    if exists (
      select 1 from screening_v2.ashby_operations t
       where t.application_link_id = v_row.link_id
         and t.operation_type = 'recommendation_tag'
    ) then
      v_skipped_has_tag_op := v_skipped_has_tag_op + 1;
      continue;
    end if;
    if v_row.session_id is null then
      v_skipped_no_session := v_skipped_no_session + 1;
      continue;
    end if;
    -- enqueue_ashby_recommendation_tag's own refusals, mirrored, so a dry run
    -- never counts a link the real run would be refused for.
    if v_row.link_session_id is distinct from v_row.session_id
       and not exists (
         select 1 from screening_v2.phone_engagements e
          where e.application_link_id = v_row.link_id
            and e.session_id = v_row.session_id
       ) then
      v_skipped_session_not_owned := v_skipped_session_not_owned + 1;
      continue;
    end if;
    if not exists (
      select 1 from screening_v2.assessments a
       where a.session_id = v_row.session_id
    ) then
      v_skipped_no_assessment := v_skipped_no_assessment + 1;
      continue;
    end if;

    v_eligible := v_eligible + 1;
    -- The verdict the worker will apply: the candidate's newest, not this
    -- session's.
    v_verdict := screening_v2.ashby_candidate_tag_verdict(
      v_row.link_id, v_row.external_candidate_id);
    case v_verdict->>'recommendation'
      when 'advance' then v_advance := v_advance + 1;
      when 'hold'    then v_hold := v_hold + 1;
      when 'reject'  then v_reject := v_reject + 1;
      else v_none := v_none + 1;
    end case;
    if v_verdict->>'evidence_grade' = 'insufficient' then
      v_evidence_insufficient := v_evidence_insufficient + 1;
    end if;

    if not p_dry_run then
      v_result := screening_v2.enqueue_ashby_recommendation_tag(
        v_row.link_id, v_row.session_id, c_actor, p_now);
      v_status := coalesce(v_result->>'status', 'unknown_status');
      v_enqueue := v_enqueue || jsonb_build_object(
        v_status, coalesce((v_enqueue->>v_status)::integer, 0) + 1);
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'ok',
    'dry_run', p_dry_run,
    'total_eligible', v_eligible,
    'verdicts', jsonb_build_object(
      'advance', v_advance, 'hold', v_hold, 'reject', v_reject, 'none', v_none),
    'evidence_insufficient', v_evidence_insufficient,
    'skipped_terminal', v_skipped_terminal,
    'skipped_mapping_inactive', v_skipped_mapping_inactive,
    'skipped_has_tag_op', v_skipped_has_tag_op,
    'skipped_no_session', v_skipped_no_session,
    'skipped_session_not_owned', v_skipped_session_not_owned,
    'skipped_no_assessment', v_skipped_no_assessment
  ) || case when p_dry_run then '{}'::jsonb
            else jsonb_build_object('enqueue', v_enqueue) end;
end;
$$;

revoke all on function screening_v2.backfill_ashby_recommendation_tags(boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.backfill_ashby_recommendation_tags(boolean, timestamptz)
  to service_role;

comment on function screening_v2.backfill_ashby_recommendation_tags is
  'Owner tool, run by hand after testing: enqueue a recommendation_tag operation for '
  'every eligible link that already has a succeeded scorecard and no tag operation '
  'yet. Order does not matter: each operation applies the candidate''s newest verdict '
  'when it runs. The dry run (p_dry_run, default true) writes nothing and mirrors the '
  'enqueue refusals. Repeat-safe. Returns counts only. Service-role only.';

notify pgrst, 'reload schema';
