-- =====================================================================
-- 0125 §5 (T06) — the zero-answer relabel, on real Postgres.
--
-- scripts/test-phone-0125.sh runs this AFTER phone_0125_finalize.sql, so
-- every migration (0125 applied twice) is in place and the `replay` chain
-- that file built (the 9f60523d sequence, finalized as an
-- unobserved_disconnect) is in _p115.fin_ids. Synthetic `p115r` namespace.
--
--   replay    Continues the 9f60523d replay: the phone assessment lands
--             (insufficient, MEASURED 0 of 5), the stranded
--             assessment.completed completes the engagement (as the API
--             handler posts it), then the RPC relabels it:
--             failed/screening_abandoned, terminal_at / next_eligible_at /
--             session_id / budgets unchanged; the candidate `screened` (the
--             old C3 rule) -> `screening`, never `queued`; both audits; no
--             new attempt, job, rescreen request or engagement, and
--             ensure_ashby_phone_engagement answers engagement_terminal (no
--             redial). A second call answers `already` and writes nothing. It
--             can never flip back: a later stranded completion is ignored,
--             complete_phone_engagement_after_late_score is not_eligible, and
--             a direct UPDATE back to completed raises.
--   refuse    The §5a exception refuses every other shape (direct UPDATEs,
--             GUC set unless the case is about the GUC): answered 1, answered
--             NULL, a decision grade, a browser row as the latest assessment,
--             a newer phone revision with answers, no GUC, a GUC naming
--             another engagement, another target state, another reason,
--             terminal_at or next_eligible_at changed, a non-completed
--             terminal source state. The RPC answers not_eligible for the
--             same data shapes, invalid_request for a NULL actor/engagement,
--             not_found for an unknown id. A positive control passes.
--   cand      The candidate guards: already `screening` (applied, not moved,
--             not audited); `rejected` / `advanced` (left); decision-blocked;
--             a human status change since the assessment; a newer assessment
--             on another session; an operator actor audits as `recruiter`.
--   converge  §5c: sweep_phone_stranded_sessions relabels right after its
--             stranded completion and its C2-P5 late completion.
--   acl       service_role only.
--
-- Synthetic identifiers only; no real candidate, email, number or document.
-- =====================================================================
\set ON_ERROR_STOP on

create schema if not exists _p115;

-- A COMPLETED phone cycle: fin_chain (in_call), one ended attempt bound to
-- the session, the session completed, the engagement completed (terminal),
-- the candidate at p_cand_status. Returns [engagement, session, candidate].
create or replace function _p115.rl_chain(
  p_slug        text,
  p_n           integer,
  p_cand_status text,
  p_at          timestamptz
)
returns uuid[]
language plpgsql as $rc$
declare
  v_ids uuid[];
begin
  v_ids := _p115.fin_chain('r-' || p_slug, 40 + p_n, 'in_call', 1, 0, p_at);
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_ids[1], 1, 1, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_ids[2],
          p_at - interval '30 seconds', p_at, p_at + interval '60 seconds');
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = p_at + interval '60 seconds', updated_at = p_at + interval '60 seconds'
   where id = v_ids[2];
  update screening_v2.phone_engagements
     set state = 'completed', terminal_at = p_at + interval '90 seconds',
         updated_at = p_at + interval '90 seconds'
   where id = v_ids[1];
  update screening_v2.candidates set status = p_cand_status where id = v_ids[3];
  return v_ids;
end;
$rc$;

-- One assessment row with the given evidence shape. Returns its id.
create or replace function _p115.rl_assess(
  p_session  uuid,
  p_cand     uuid,
  p_source   text,
  p_grade    text,
  p_reason   text,
  p_answered integer,
  p_planned  integer,
  p_at       timestamptz,
  p_revision integer default 1
)
returns uuid
language plpgsql as $ra$
declare
  v_id uuid;
begin
  insert into screening_v2.assessments
    (session_id, candidate_id, overall_score, recommendation, summary, raw, provenance,
     source, revision, evidence_grade, evidence_reason, evidence_answered, evidence_planned,
     created_at)
  values (p_session, p_cand, 20, 'reject', 'p115r synthetic', '{}'::jsonb,
          '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb,
          p_source, p_revision, p_grade, p_reason, p_answered, p_planned, p_at)
  returning id into v_id;
  return v_id;
end;
$ra$;

-- Try the relabel UPDATE directly. p_guc: the GUC value to set first (NULL =
-- leave it unset). Returns 'allowed' or the refusal's SQLSTATE.
create or replace function _p115.rl_try(
  p_eng    uuid,
  p_guc    text,
  p_state  text default 'failed',
  p_reason text default 'screening_abandoned',
  p_extra  text default null
)
returns text
language plpgsql as $rt$
begin
  if p_guc is not null then
    perform set_config('screening_v2.zero_answer_relabel', p_guc, true);
  end if;
  begin
    update screening_v2.phone_engagements
       set state            = p_state,
           state_reason     = p_reason,
           version          = version + 1,
           terminal_at      = case when p_extra = 'terminal_at'
                                   then terminal_at + interval '1 second' else terminal_at end,
           next_eligible_at = case when p_extra = 'next_eligible_at'
                                   then '2026-10-06T04:00:00Z'::timestamptz else next_eligible_at end
     where id = p_eng;
    -- Allowed. Raise our own code so this block's implicit savepoint rolls
    -- the UPDATE back: the case leaves the row as it found it (there is no
    -- legal UPDATE back from failed/screening_abandoned).
    raise exception using errcode = 'P0999', message = 'rl_try allowed';
  exception
    when sqlstate 'P0999' then
      perform set_config('screening_v2.zero_answer_relabel', '', true);
      return 'allowed';
    when others then
      perform set_config('screening_v2.zero_answer_relabel', '', true);
      return sqlstate;
  end;
end;
$rt$;

-- ─────────────────────────────────────────────────────────────────────
-- replay — continue the 9f60523d sequence to the relabel.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_eng uuid; v_sess uuid; v_cand uuid; v_link uuid;
  v_before screening_v2.phone_engagements%rowtype;
  v_after  screening_v2.phone_engagements%rowtype;
  v_ev jsonb; v_res jsonb; v_ens jsonb;
  v_status text; v_n_att integer; v_n_job integer; v_n_rs integer; v_n_eng integer;
  v_n_audit integer; v_meta jsonb;
begin
  select ids into v_ids from _p115.fin_ids where slug = 'replay';
  if v_ids is null then
    raise exception 'p115r replay: phone_0125_finalize.sql must run first (no replay chain)';
  end if;
  v_eng := v_ids[1]; v_sess := v_ids[2];
  select candidate_id into v_cand from screening_v2.call_sessions where id = v_sess;
  select application_link_id into v_link from screening_v2.phone_engagements where id = v_eng;

  -- The handler scores first (the 0044 interlock): an unobserved_disconnect
  -- with no candidate turn grades insufficient/no_candidate_speech, and the
  -- plan's 5 questions with 0 answered is MEASURED.
  perform _p115.rl_assess(v_sess, v_cand, 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T03:45:30Z');
  -- The historical C3 rule (before the API narrowing) marked the candidate.
  update screening_v2.candidates set status = 'screened' where id = v_cand;

  -- The handler's stranded completion post (partial path).
  v_ev := screening_v2.apply_phone_event('internal', 'assessment.completed', null, v_eng,
            'assessment:' || v_sess::text, null, null, '2026-10-05T03:45:40Z');
  select * into v_before from screening_v2.phone_engagements where id = v_eng;
  if v_ev->>'status' <> 'applied' or v_before.state <> 'completed' or v_before.terminal_at is null then
    raise exception 'p115r replay: the stranded completion must complete the engagement; event=% state=%',
      v_ev, v_before.state;
  end if;

  select count(*) into v_n_att from screening_v2.phone_call_attempts where engagement_id = v_eng;
  select count(*) into v_n_job from screening_v2.job_queue;
  select count(*) into v_n_rs from screening_v2.phone_rescreen_requests where application_link_id = v_link;
  select count(*) into v_n_eng from screening_v2.phone_engagements where application_link_id = v_link;

  v_res := screening_v2.relabel_zero_answer_phone_engagement(
             v_eng, '00000000-0000-0000-0000-000000000000', '2026-10-05T03:46:00Z');
  if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean is not true
     or (v_res->>'engagement_id')::uuid <> v_eng or (v_res->>'session_id')::uuid <> v_sess then
    raise exception 'p115r replay: expected applied with the candidate moved; got %', v_res;
  end if;

  select * into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after.state <> 'failed' or v_after.state_reason <> 'screening_abandoned'
     or v_after.version <> v_before.version + 1
     or v_after.updated_at <> '2026-10-05T03:46:00Z'::timestamptz
     or (to_jsonb(v_after) - '{state,state_reason,version,updated_at}'::text[])
        <> (to_jsonb(v_before) - '{state,state_reason,version,updated_at}'::text[]) then
    raise exception 'p115r replay: the relabel must change only state/state_reason/version/updated_at; '
      'before=% after=%', to_jsonb(v_before), to_jsonb(v_after);
  end if;

  select status into v_status from screening_v2.candidates where id = v_cand;
  if v_status <> 'screening' then
    raise exception 'p115r replay: the candidate must be back at screening (never queued); got %', v_status;
  end if;

  select metadata into v_meta from screening_v2.audit_events
   where action = 'screening_failed' and target_type = 'phone_engagement'
     and target_id = v_eng::text and actor_type = 'system';
  if v_meta is null
     or v_meta - 'session_id' <> '{"from":"completed","to":"failed","reason":"screening_abandoned","migration":"0125"}'::jsonb
     or (v_meta->>'session_id')::uuid <> v_sess then
    raise exception 'p115r replay: engagement audit missing or wrong: %', v_meta;
  end if;
  select metadata into v_meta from screening_v2.audit_events
   where action = 'candidate_status_changed' and target_type = 'candidate'
     and target_id = v_cand::text and actor_type = 'system';
  if v_meta is distinct from
     '{"from":"screened","to":"screening","reason":"screening_abandoned","migration":"0125"}'::jsonb then
    raise exception 'p115r replay: candidate audit missing or wrong: %', v_meta;
  end if;

  if (select count(*) from screening_v2.phone_call_attempts where engagement_id = v_eng) <> v_n_att
     or (select count(*) from screening_v2.job_queue) <> v_n_job
     or (select count(*) from screening_v2.phone_rescreen_requests where application_link_id = v_link) <> v_n_rs then
    raise exception 'p115r replay: the relabel must create no attempt, job or rescreen request';
  end if;

  -- Nothing redials: the cycle is terminal, so ensure answers
  -- engagement_terminal and opens no new engagement.
  v_ens := screening_v2.ensure_ashby_phone_engagement(v_link, '2026-10-05T03:47:00Z');
  if v_ens->>'status' <> 'engagement_terminal'
     or (select count(*) from screening_v2.phone_engagements where application_link_id = v_link) <> v_n_eng then
    raise exception 'p115r replay: ensure must answer engagement_terminal and open nothing; got %', v_ens;
  end if;

  -- Idempotent: already, nothing written.
  select count(*) into v_n_audit from screening_v2.audit_events
   where target_id in (v_eng::text, v_cand::text);
  v_res := screening_v2.relabel_zero_answer_phone_engagement(
             v_eng, '00000000-0000-0000-0000-000000000000', '2026-10-05T03:48:00Z');
  if v_res->>'status' <> 'already'
     or (select count(*) from screening_v2.audit_events where target_id in (v_eng::text, v_cand::text)) <> v_n_audit
     or (select version from screening_v2.phone_engagements where id = v_eng) <> v_after.version then
    raise exception 'p115r replay: a second call must answer already and write nothing; got %', v_res;
  end if;

  -- Never flipped back. (1) A later stranded completion (a DLQ replay) is
  -- ignored on a terminal engagement.
  v_ev := screening_v2.apply_phone_event('internal', 'assessment.completed', null, v_eng,
            'p115r-late:' || v_sess::text, null, null, '2026-10-05T03:50:00Z');
  if v_ev->>'status' = 'applied' then
    raise exception 'p115r replay: a late stranded completion was applied: %', v_ev;
  end if;
  -- (2) The 0114 late-score relabel matches only assessment_aborted.
  v_res := screening_v2.complete_phone_engagement_after_late_score(v_eng, '2026-10-05T03:51:00Z');
  if v_res->>'status' <> 'not_eligible' then
    raise exception 'p115r replay: complete_phone_engagement_after_late_score must refuse; got %', v_res;
  end if;
  -- (3) A direct relabel back to completed raises.
  if _p115.rl_try(v_eng, null, 'completed', 'late_score_after_stranded_abort') <> 'P0001'
     or _p115.rl_try(v_eng, v_eng::text, 'completed', null) <> 'P0001' then
    raise exception 'p115r replay: failed/screening_abandoned must never flip back to completed';
  end if;
  select state, state_reason into v_after.state, v_after.state_reason
    from screening_v2.phone_engagements where id = v_eng;
  if v_after.state <> 'failed' or v_after.state_reason <> 'screening_abandoned' then
    raise exception 'p115r replay: engagement moved after the relabel: %/%', v_after.state, v_after.state_reason;
  end if;

  raise notice 'p115r replay: PASS (failed/screening_abandoned, candidate screening, audited, no redial, '
    'idempotent, never flipped back)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- refuse — the §5a exception and the RPC refuse every other shape.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_r text; v_res jsonb;
  v_case record;
begin
  -- Data shapes, each on its own completed cycle. GUC set: the data
  -- predicate alone must refuse.
  for v_case in
    select * from (values
      ('ans1',     1, 'phone', 'insufficient', 'partial_thin',  1),
      ('ansnull',  2, 'phone', 'insufficient', 'no_plan',       null),
      ('decision', 3, 'phone', 'decision',     'complete_call', 0)
    ) t(slug, n, source, grade, reason, answered)
  loop
    v_ids := _p115.rl_chain(v_case.slug, v_case.n, 'screened', '2026-10-05T12:00:00Z');
    insert into _p115.fin_ids values ('r-' || v_case.slug, v_ids);
    perform _p115.rl_assess(v_ids[2], v_ids[3], v_case.source, v_case.grade, v_case.reason,
                            v_case.answered, case when v_case.answered is null then null else 5 end,
                            '2026-10-05T12:02:00Z');
    v_r := _p115.rl_try(v_ids[1], v_ids[1]::text);
    if v_r <> 'P0001' then
      raise exception 'p115r refuse %: the exception must refuse this shape; got %', v_case.slug, v_r;
    end if;
    v_res := screening_v2.relabel_zero_answer_phone_engagement(
               v_ids[1], '00000000-0000-0000-0000-000000000000', '2026-10-05T12:05:00Z');
    if v_res->>'status' <> 'not_eligible' or v_res->>'reason' <> 'not_zero_answer' then
      raise exception 'p115r refuse %: the RPC must answer not_eligible/not_zero_answer; got %',
        v_case.slug, v_res;
    end if;
    if (select status from screening_v2.candidates where id = v_ids[3]) <> 'screened'
       or (select state from screening_v2.phone_engagements where id = v_ids[1]) <> 'completed' then
      raise exception 'p115r refuse %: a refused call must change nothing', v_case.slug;
    end if;
  end loop;

  -- A browser row is the session's latest assessment (an older phone row
  -- WOULD qualify). It even carries the 0-answer evidence shape, so only
  -- the `source = 'phone'` clause refuses it.
  v_ids := _p115.rl_chain('browser', 10, 'screened', '2026-10-05T12:10:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:12:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'browser', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:13:00Z');
  if _p115.rl_try(v_ids[1], v_ids[1]::text) <> 'P0001'
     or screening_v2.relabel_zero_answer_phone_engagement(
          v_ids[1], '00000000-0000-0000-0000-000000000000', '2026-10-05T12:15:00Z')->>'status'
        <> 'not_eligible' then
    raise exception 'p115r refuse browser: a non-phone latest assessment must refuse';
  end if;

  -- A newer phone REVISION (a rescore) with answers supersedes the 0-answer
  -- row: refused.
  v_ids := _p115.rl_chain('rescored', 11, 'screened', '2026-10-05T12:20:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:22:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'partial_thin', 2, 5,
                          '2026-10-05T12:23:00Z', 2);
  if _p115.rl_try(v_ids[1], v_ids[1]::text) <> 'P0001'
     or screening_v2.relabel_zero_answer_phone_engagement(
          v_ids[1], '00000000-0000-0000-0000-000000000000', '2026-10-05T12:25:00Z')->>'status'
        <> 'not_eligible' then
    raise exception 'p115r refuse rescored: a newer phone revision with answers must refuse';
  end if;

  -- The qualifying shape, to isolate everything that is NOT the data.
  v_ids := _p115.rl_chain('shape', 12, 'screened', '2026-10-05T12:30:00Z');
  insert into _p115.fin_ids values ('r-shape', v_ids);
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:32:00Z');

  v_r := _p115.rl_try(v_ids[1], null);
  if v_r <> 'P0001' then raise exception 'p115r refuse: no GUC must refuse; got %', v_r; end if;
  v_r := _p115.rl_try(v_ids[1], gen_random_uuid()::text);
  if v_r <> 'P0001' then raise exception 'p115r refuse: a GUC naming another engagement must refuse; got %', v_r; end if;
  v_r := _p115.rl_try(v_ids[1], v_ids[1]::text, 'cancelled', 'screening_abandoned');
  if v_r <> 'P0001' then raise exception 'p115r refuse: another target state must refuse; got %', v_r; end if;
  v_r := _p115.rl_try(v_ids[1], v_ids[1]::text, 'failed', 'assessment_aborted');
  if v_r <> 'P0001' then raise exception 'p115r refuse: another reason must refuse; got %', v_r; end if;
  v_r := _p115.rl_try(v_ids[1], v_ids[1]::text, 'failed', 'screening_abandoned', 'terminal_at');
  if v_r <> 'P0001' then raise exception 'p115r refuse: a terminal_at change must refuse; got %', v_r; end if;
  v_r := _p115.rl_try(v_ids[1], v_ids[1]::text, 'failed', 'screening_abandoned', 'next_eligible_at');
  if v_r <> 'P0001' then raise exception 'p115r refuse: a next_eligible_at change must refuse; got %', v_r; end if;
  -- Positive control: the exact shape, GUC naming this engagement.
  v_r := _p115.rl_try(v_ids[1], v_ids[1]::text);
  if v_r <> 'allowed' then raise exception 'p115r refuse: the qualifying shape must be allowed; got %', v_r; end if;
  -- The RPC clears the GUC straight after its UPDATE, so a later statement
  -- in the same transaction cannot ride it.
  if screening_v2.relabel_zero_answer_phone_engagement(
       v_ids[1], '00000000-0000-0000-0000-000000000000', '2026-10-05T12:35:00Z')->>'status' <> 'applied'
     or coalesce(current_setting('screening_v2.zero_answer_relabel', true), '') <> '' then
    raise exception 'p115r refuse: the RPC must apply on the qualifying shape and clear the GUC';
  end if;

  -- A non-completed terminal source state (opted_out) with the same data.
  -- The trigger admits no UPDATE into opted_out from completed, so the
  -- terminal opted_out row is INSERTED (on a second application link, bound
  -- to the same qualifying session) and the relabel is tried on it.
  v_ids := _p115.rl_chain('optout', 13, 'screened', '2026-10-05T12:40:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:42:00Z');
  declare
    v_term uuid; v_link2 uuid; v_map uuid;
  begin
    select job_mapping_id into v_map from screening_v2.ashby_application_links
     where id = (select application_link_id from screening_v2.phone_engagements where id = v_ids[1]);
    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle, candidate_id)
    values ('p115r-optout-2-app', 'p115f-r-optout-job', v_map, repeat('h', 64), v_ids[3])
    returning id into v_link2;
    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state, state_reason, epoch, terminal_at, session_id)
    select v_link2, candidate_id, role_id, 'opted_out', 'candidate_opt_out', 1,
           '2026-10-05T12:43:00Z', session_id
      from screening_v2.phone_engagements where id = v_ids[1]
    returning id into v_term;
    v_r := _p115.rl_try(v_term, v_term::text);
    if v_r <> 'P0001' then
      raise exception 'p115r refuse optout: a non-completed terminal source state must refuse; got %', v_r;
    end if;
    v_res := screening_v2.relabel_zero_answer_phone_engagement(
               v_term, '00000000-0000-0000-0000-000000000000', '2026-10-05T12:45:00Z');
    if v_res->>'status' <> 'not_eligible' or v_res->>'reason' <> 'not_completed' then
      raise exception 'p115r refuse optout: the RPC must answer not_eligible/not_completed; got %', v_res;
    end if;
  end;

  -- Argument refusals.
  v_res := screening_v2.relabel_zero_answer_phone_engagement(null, '00000000-0000-0000-0000-000000000000', '2026-10-05T12:50:00Z');
  if v_res->>'status' <> 'not_eligible' or v_res->>'reason' <> 'invalid_request' then
    raise exception 'p115r refuse: a NULL engagement must answer invalid_request; got %', v_res;
  end if;
  v_ids := _p115.rl_chain('noactor', 14, 'screened', '2026-10-05T12:46:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T12:47:00Z');
  v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], null, '2026-10-05T12:50:00Z');
  if v_res->>'status' <> 'not_eligible' or v_res->>'reason' <> 'invalid_request'
     or (select state from screening_v2.phone_engagements where id = v_ids[1]) <> 'completed' then
    raise exception 'p115r refuse: a NULL actor must answer invalid_request and write nothing; got %', v_res;
  end if;
  v_res := screening_v2.relabel_zero_answer_phone_engagement(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', '2026-10-05T12:50:00Z');
  if v_res->>'status' <> 'not_eligible' or v_res->>'reason' <> 'not_found' then
    raise exception 'p115r refuse: an unknown engagement must answer not_found; got %', v_res;
  end if;

  raise notice 'p115r refuse: PASS (every non-qualifying shape refused by the trigger and the RPC)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- cand — the candidate guards (0114 §4e).
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_ids uuid[]; v_res jsonb; v_other uuid[];
  v_op constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_sys constant uuid := '00000000-0000-0000-0000-000000000000';
  v_case record;
begin
  -- The engagement is relabelled in every case; only the candidate differs.
  for v_case in
    select * from (values
      ('screening', 21, 'screening', false),
      ('rejected',  22, 'rejected',  false),
      ('advanced',  23, 'advanced',  false)
    ) t(slug, n, status, moved)
  loop
    v_ids := _p115.rl_chain('c-' || v_case.slug, v_case.n, v_case.status, '2026-10-05T13:00:00Z');
    perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                            '2026-10-05T13:02:00Z');
    v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], v_sys, '2026-10-05T13:05:00Z');
    if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean <> v_case.moved
       or (select status from screening_v2.candidates where id = v_ids[3]) <> v_case.status
       or (select state_reason from screening_v2.phone_engagements where id = v_ids[1]) <> 'screening_abandoned'
       or exists (select 1 from screening_v2.audit_events
                   where action = 'candidate_status_changed' and target_id = v_ids[3]::text) then
      raise exception 'p115r cand %: engagement relabelled, candidate left and not audited; got %',
        v_case.slug, v_res;
    end if;
  end loop;

  -- Decision-blocked: left.
  v_ids := _p115.rl_chain('c-blocked', 31, 'screened', '2026-10-05T13:10:00Z');
  update screening_v2.candidates set decision_use_blocked_at = '2026-10-05T13:11:00Z' where id = v_ids[3];
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T13:12:00Z');
  v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], v_sys, '2026-10-05T13:15:00Z');
  if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean
     or (select status from screening_v2.candidates where id = v_ids[3]) <> 'screened' then
    raise exception 'p115r cand blocked: a decision-blocked candidate must not move; got %', v_res;
  end if;

  -- A human status change since the assessment: theirs stands.
  v_ids := _p115.rl_chain('c-human', 32, 'screened', '2026-10-05T13:20:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T13:22:00Z');
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata, created_at)
  values (v_op, 'recruiter', 'candidate_status_changed', 'candidate', v_ids[3]::text, 'success',
          '{"from_status":"screening","to_status":"screened"}'::jsonb, '2026-10-05T13:23:00Z');
  v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], v_sys, '2026-10-05T13:25:00Z');
  if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean
     or (select status from screening_v2.candidates where id = v_ids[3]) <> 'screened' then
    raise exception 'p115r cand human: a human status change since must stand; got %', v_res;
  end if;

  -- A newer assessment on ANOTHER session of the same candidate: left.
  v_ids := _p115.rl_chain('c-newer', 33, 'screened', '2026-10-05T13:30:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T13:32:00Z');
  v_other := _p115.rl_chain('c-newer-2', 34, 'new', '2026-10-05T13:33:00Z');
  update screening_v2.candidates set status = 'screened' where id = v_ids[3];
  perform _p115.rl_assess(v_other[2], v_ids[3], 'phone', 'decision', 'complete_call', 5, 5,
                          '2026-10-05T13:34:00Z');
  v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], v_sys, '2026-10-05T13:35:00Z');
  if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean
     or (select status from screening_v2.candidates where id = v_ids[3]) <> 'screened' then
    raise exception 'p115r cand newer: a newer assessment owns the candidate status; got %', v_res;
  end if;

  -- The operator correction audits as `recruiter` with the operator id.
  v_ids := _p115.rl_chain('c-operator', 35, 'screened', '2026-10-05T13:40:00Z');
  perform _p115.rl_assess(v_ids[2], v_ids[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-05T13:42:00Z');
  v_res := screening_v2.relabel_zero_answer_phone_engagement(v_ids[1], v_op, '2026-10-05T13:45:00Z');
  if v_res->>'status' <> 'applied' or (v_res->>'candidate_moved')::boolean is not true
     or (select status from screening_v2.candidates where id = v_ids[3]) <> 'screening'
     or (select count(*) from screening_v2.audit_events
          where actor_id = v_op and actor_type = 'recruiter'
            and target_id in (v_ids[1]::text, v_ids[3]::text)
            and created_at = '2026-10-05T13:45:00Z'
            and action in ('screening_failed', 'candidate_status_changed')) <> 2 then
    raise exception 'p115r cand operator: expected applied, moved, two recruiter audits; got %', v_res;
  end if;

  raise notice 'p115r cand: PASS (screening/rejected/advanced/blocked/human/newer left; operator audited)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- converge — §5c: the relabel also runs when sweep_phone_stranded_sessions
-- completes the engagement AFTER the handler ran (adversarial review, S02).
--   stranded  The handler scored a measured 0-answer row while the
--             engagement was not yet completed (dialing/in_call), so its
--             relabel answered not_eligible. Later the engagement is
--             `eligible` with a terminal session and the stranded sweep posts
--             assessment.completed: it must end failed/screening_abandoned in
--             the same pass, the candidate left at `screening` (the C3 rule
--             no longer moved it), one system screening_failed audit.
--   answered  Control: the same shape with 2 answers stays completed.
--   late      The sweep aborts first (no score yet: failed/
--             assessment_aborted), then the 0-answer score lands late. The
--             C2-P5 late completion and the relabel run in the same pass:
--             failed/screening_abandoned, terminal_at the abort's, never
--             selected again.
-- p_now is far in the future so the 900 s stillness grace holds whatever the
-- container clock wrote into updated_at; the limit is the maximum (200) so
-- earlier fixtures cannot crowd these out.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_z uuid[]; v_a uuid[]; v_l uuid[]; v_res jsonb; v_e screening_v2.phone_engagements%rowtype;
  v_terminal timestamptz;
  v_p1 constant timestamptz := '2030-01-01T00:00:00Z';
  v_p2 constant timestamptz := '2030-01-01T01:00:00Z';
  v_p3 constant timestamptz := '2030-01-01T02:00:00Z';
begin
  -- Three eligible engagements bound to a COMPLETED session.
  v_z := _p115.fin_chain('cv-stranded', 90, 'eligible', 1, 0, '2026-10-06T03:00:00Z');
  v_a := _p115.fin_chain('cv-answered', 91, 'eligible', 1, 0, '2026-10-06T03:00:00Z');
  v_l := _p115.fin_chain('cv-late',     92, 'eligible', 1, 0, '2026-10-06T03:00:00Z');
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = '2026-10-06T03:05:00Z', updated_at = '2026-10-06T03:05:00Z'
   where id in (v_z[2], v_a[2], v_l[2]);
  update screening_v2.candidates set status = 'screening' where id in (v_z[3], v_a[3], v_l[3]);
  perform _p115.rl_assess(v_z[2], v_z[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2026-10-06T03:06:00Z');
  perform _p115.rl_assess(v_a[2], v_a[3], 'phone', 'insufficient', 'partial_thin', 2, 5,
                          '2026-10-06T03:06:00Z');

  v_res := screening_v2.sweep_phone_stranded_sessions(200, v_p1);
  if v_res->>'status' <> 'ok'
     or coalesce((v_res->>'zero_answer_relabelled')::integer, 0) < 1
     or coalesce((v_res->>'zero_answer_relabel_errors')::integer, -1) <> 0 then
    raise exception 'p115r converge stranded: expected ok, >= 1 relabelled, 0 errors; got %', v_res;
  end if;

  select * into v_e from screening_v2.phone_engagements where id = v_z[1];
  if v_e.state <> 'failed' or v_e.state_reason <> 'screening_abandoned' or v_e.terminal_at <> v_p1
     or v_e.session_id <> v_z[2] then
    raise exception 'p115r converge stranded: expected failed/screening_abandoned at the completion instant; got %/% %',
      v_e.state, v_e.state_reason, v_e.terminal_at;
  end if;
  if (select status from screening_v2.candidates where id = v_z[3]) <> 'screening'
     or (select count(*) from screening_v2.audit_events
          where action = 'screening_failed' and target_type = 'phone_engagement'
            and target_id = v_z[1]::text and actor_type = 'system'
            and metadata->>'reason' = 'screening_abandoned') <> 1
     or exists (select 1 from screening_v2.audit_events
                 where action = 'candidate_status_changed' and target_id = v_z[3]::text) then
    raise exception 'p115r converge stranded: candidate must stay screening (not audited), one engagement audit';
  end if;

  select * into v_e from screening_v2.phone_engagements where id = v_a[1];
  if v_e.state <> 'completed' then
    raise exception 'p115r converge answered: a screening with answers must stay completed; got %/%',
      v_e.state, v_e.state_reason;
  end if;

  select * into v_e from screening_v2.phone_engagements where id = v_l[1];
  if v_e.state <> 'failed' or v_e.state_reason <> 'assessment_aborted' then
    raise exception 'p115r converge late: the unscored session must abort first; got %/%',
      v_e.state, v_e.state_reason;
  end if;
  v_terminal := v_e.terminal_at;

  -- The 0-answer score lands late (a DLQ replay).
  perform _p115.rl_assess(v_l[2], v_l[3], 'phone', 'insufficient', 'no_candidate_speech', 0, 5,
                          '2030-01-01T00:30:00Z');
  v_res := screening_v2.sweep_phone_stranded_sessions(200, v_p2);
  select * into v_e from screening_v2.phone_engagements where id = v_l[1];
  if v_e.state <> 'failed' or v_e.state_reason <> 'screening_abandoned' or v_e.terminal_at <> v_terminal
     or coalesce((v_res->>'late_completed')::integer, 0) < 1
     or coalesce((v_res->>'zero_answer_relabelled')::integer, 0) < 1
     or coalesce((v_res->>'zero_answer_relabel_errors')::integer, -1) <> 0 then
    raise exception 'p115r converge late: expected late completion then failed/screening_abandoned, terminal_at kept; '
      'got %/% %, sweep %', v_e.state, v_e.state_reason, v_e.terminal_at, v_res;
  end if;
  if (select status from screening_v2.candidates where id = v_l[3]) <> 'screening' then
    raise exception 'p115r converge late: the candidate must stay at screening (never queued)';
  end if;

  -- A third pass changes nothing on any of the three.
  v_res := screening_v2.sweep_phone_stranded_sessions(200, v_p3);
  if (select version from screening_v2.phone_engagements where id = v_l[1]) <> v_e.version
     or (select state_reason from screening_v2.phone_engagements where id = v_z[1]) <> 'screening_abandoned'
     or (select state from screening_v2.phone_engagements where id = v_a[1]) <> 'completed' then
    raise exception 'p115r converge: a later pass must change nothing; got %', v_res;
  end if;

  raise notice 'p115r converge: PASS (stranded and late completions relabelled in the same pass; answered kept)';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- acl — service_role only.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_fn constant text := 'screening_v2.relabel_zero_answer_phone_engagement(uuid,uuid,timestamptz)';
begin
  if not has_function_privilege('service_role', v_fn, 'execute')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception 'p115r acl: the relabel RPC must be executable by service_role only';
  end if;
  if (select prosecdef from pg_proc where oid = v_fn::regprocedure) is not true then
    raise exception 'p115r acl: the relabel RPC must be SECURITY DEFINER';
  end if;
  raise notice 'p115r acl: PASS';
end $$;

select 'p115 zero-answer relabel' as suite, 'PASS' as result;
