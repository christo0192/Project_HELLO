-- =====================================================================
-- 0086 — Durable per-key boundary DISPOSITION (Codex review Finding B).
--
-- FORWARD-ONLY. Adds ONE nullable, CHECK-bounded column to
-- `phone_session_progress`, and re-declares the two boundary-commit RPCs
-- with ONE defaulted parameter each (before p_now — see below). No other table, column,
-- index, trigger or grant is touched. 0044/0052/0071/0075/0077 and every
-- earlier migration stay byte-identical.
--
-- ── THE DEFECT (review §4, 2026-09-07) ────────────────────────────────
-- A `phone_session_progress` row has always meant "this key was asked,
-- answered, and both halves of the exchange are durable" (0044's own
-- comment) — but the worker's commit machinery can advance a populated
-- boundary whose ask was NEVER meaningfully established (non-mandatory
-- objectives advance on a drifted ask; mandatory ones advance after the
-- bounded re-ask caps), and PR #257 recorded that honesty ONLY in the
-- in-memory boundary dictionary and a log line. The wire and the table
-- kept implying asked/covered. Two live calls in a row committed
-- questions that were never spoken, and nothing durable could say so.
--
-- ── THE MODEL ─────────────────────────────────────────────────────────
-- The worker computes, at commit time, ONE of six truthful outcomes and
-- the row records it:
--
--   asked_answered            — the ask was delivered and the candidate
--                               answered it (topically; the broad
--                               substantive-speech predicate is NOT
--                               evidence of coverage — review §6).
--   volunteered_with_evidence — the ask was NOT delivered (or is a
--                               contiguous forward-skip row), but the
--                               candidate's own words carry
--                               high-confidence evidence covering the
--                               objective. Real provenance, no invented
--                               bot turn.
--   asked_declined            — delivered, and the candidate explicitly
--                               declined to answer.
--   asked_unanswered          — delivered, never answered (bounded
--                               re-asks exhausted, or the only
--                               substantive speech was off-topic).
--   not_delivered             — never delivered, no volunteered
--                               evidence; the cursor still advanced
--                               under the bounded policy.
--   skipped_bounded           — a MANDATORY ask whose delivery re-asks
--                               were exhausted; the bounded policy gave
--                               up explicitly.
--
-- CURSOR ADVANCEMENT MUST NOT IMPLY ASKED OR COVERED. The column is the
-- durable record of which it was.
--
-- NULLABLE, DELIBERATELY: every pre-0086 row (and any commit from an
-- older worker, or from the tool-first lane which computes no
-- dimensions) records NULL — an honest "not measured", never a guessed
-- enum member. The CHECK closes the vocabulary for every non-null write.
--
-- ── WHY THE PARAMETER SITS BEFORE p_now ───────────────────────────────
-- The repo-wide RPC contract pins `p_now` as the FINAL parameter of
-- every time-dependent phone RPC (time is injected, uniformly, last) —
-- a drift test enforces it. `p_disposition text default null` therefore
-- slots in BEFORE `p_now`. In-repo positional callers (policy tests)
-- switch their final argument to named `p_now =>` notation; PostgREST
-- callers are named already, and a deployed API that does not send the
-- argument keeps working through the default. The OLD signatures are
-- dropped first because a defaulted overload alongside the original
-- would make every legacy named call ambiguous (PostgREST 300).
--
-- ── WRITE-ONCE IS PRESERVED ───────────────────────────────────────────
-- `phone_session_progress` keeps its 0044 UPDATE-blocking trigger, so a
-- disposition is written exactly once, in the same transaction as the
-- turns it describes and the cursor advance it earns. There is no
-- correction path short of deleting the session — the same contract as
-- every other column on the row.
-- =====================================================================

-- ── 1. the column and its closed vocabulary ───────────────────────────

alter table screening_v2.phone_session_progress
  add column if not exists disposition text;

alter table screening_v2.phone_session_progress
  drop constraint if exists chk_phone_session_progress_disposition;
alter table screening_v2.phone_session_progress
  add constraint chk_phone_session_progress_disposition check (
    disposition is null or disposition in (
      'asked_answered', 'volunteered_with_evidence', 'asked_declined',
      'asked_unanswered', 'not_delivered', 'skipped_bounded'));

comment on column screening_v2.phone_session_progress.disposition is
  '0086 (Codex review Finding B): the truthful per-key outcome, written '
  'by the worker AT COMMIT in the same transaction as the cursor '
  'advance. One of asked_answered / volunteered_with_evidence / '
  'asked_declined / asked_unanswered / not_delivered / skipped_bounded. '
  'NULL means "not measured" (pre-0086 rows, older workers, the '
  'tool-first lane) — never a guess. Cursor advancement does not imply '
  'asked or covered; this column records which it was.';

-- ── 2. commit_phone_question_boundary — 0071 body + the disposition ───
-- Replaced in full (a signature cannot be patched in place). The ONLY
-- changes from 0071 are: the appended `p_disposition` parameter, its
-- closed-vocabulary refusal (`invalid_disposition`, checked with the
-- other input validation BEFORE anything is written), and the progress
-- INSERT carrying the value. Every other behaviour — the session row
-- lock, shape/timing validation, the duplicate read-back, the
-- authorship-guarded turn insert, the cursor CAS, the return shape — is
-- byte-for-byte 0071.

drop function if exists screening_v2.commit_phone_question_boundary(
  uuid, text, integer, text, jsonb, timestamptz);

create or replace function screening_v2.commit_phone_question_boundary(
  p_session_id      uuid,
  p_question_key    text,
  p_expected_index  integer,
  p_source_event_id text,
  p_turns           jsonb,
  p_disposition     text default null,
  p_now             timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess       screening_v2.call_sessions%rowtype;
  v_plan       screening_v2.phone_session_plans%rowtype;
  v_prog       screening_v2.phone_session_progress%rowtype;
  v_item       jsonb;
  v_speaker    text;
  v_text       text;
  v_count      integer;
  v_cursor     integer;
  v_expected   text;
  v_base       integer;
  v_updated    integer;
  v_per_item   boolean;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'plan_missing');
  end if;

  if p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_question_key is null
     or p_turns is null
     or jsonb_typeof(p_turns) <> 'array' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;
  -- 0086: a non-null disposition must be a member of the closed
  -- vocabulary. Refused BEFORE any write — the API schema gates the same
  -- enum a round-trip earlier, but the database is the boundary of
  -- record and defends its own column.
  if p_disposition is not null and p_disposition not in (
       'asked_answered', 'volunteered_with_evidence', 'asked_declined',
       'asked_unanswered', 'not_delivered', 'skipped_bounded') then
    return jsonb_build_object('status', 'invalid_disposition');
  end if;
  v_count := jsonb_array_length(p_turns);
  if v_count < 2 or v_count > 12 then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  for v_item in select value from jsonb_array_elements(p_turns) loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    v_speaker := v_item ->> 'speaker';
    v_text    := btrim(coalesce(v_item ->> 'text', ''));
    if v_speaker is null
       or v_speaker not in ('bot','candidate')
       or v_text = ''
       or length(v_text) > 8000 then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    if v_item ? 'turn_started_at_ms'
       and v_item ->> 'turn_started_at_ms' is not null
       and (jsonb_typeof(v_item -> 'turn_started_at_ms') <> 'number'
            or v_item ->> 'turn_started_at_ms' !~ '^[1-9][0-9]{0,15}$'
            or (v_item ->> 'turn_started_at_ms')::numeric >= 4102444800000) then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
  end loop;

  if (p_turns -> 0 ->> 'speaker') <> 'bot'
     or (p_turns -> (v_count - 1) ->> 'speaker') <> 'candidate' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  select * into v_prog from screening_v2.phone_session_progress
   where session_id = p_session_id and source_event_id = p_source_event_id;
  if found then
    return jsonb_build_object(
      'status', 'applied',
      'applied', true,
      'duplicate', true,
      'question_key', v_prog.question_key,
      'question_index', v_prog.question_index,
      'first_turn_index', v_prog.first_turn_index,
      'last_turn_index', v_prog.last_turn_index,
      'cursor', greatest(coalesce(v_sess.current_question_index, 0), 0),
      'question_count', v_plan.question_count,
      'plan_complete',
        greatest(coalesce(v_sess.current_question_index, 0), 0) >= v_plan.question_count);
  end if;

  if v_sess.status <> 'in_progress' then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if p_expected_index is null or p_expected_index <> v_cursor then
    return jsonb_build_object('status', 'stale_cursor',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  if v_cursor >= v_plan.question_count then
    return jsonb_build_object('status', 'plan_complete',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  v_expected := v_plan.questions -> v_cursor ->> 'key';
  if p_question_key <> v_expected then
    return jsonb_build_object('status', 'key_not_current',
                              'cursor', v_cursor,
                              'expected_key', v_expected,
                              'question_count', v_plan.question_count);
  end if;

  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  -- ── THE AUTHORSHIP GUARD (0071 / X4b, unchanged) ───────────────────
  select exists (
    select 1 from screening_v2.transcript_turns
     where session_id = p_session_id
       and source_item_id is not null
       and coalesce(is_gate, false) = false
  ) into v_per_item;

  if not v_per_item then
    insert into screening_v2.transcript_turns
      (session_id, turn_index, speaker, text, created_at, turn_started_at_ms)
    select p_session_id,
           v_base + (t.ord - 1)::integer,
           t.value ->> 'speaker',
           btrim(t.value ->> 'text'),
           p_now,
           case when t.value ->> 'turn_started_at_ms' is null then null
                else (t.value ->> 'turn_started_at_ms')::bigint end
      from jsonb_array_elements(p_turns) with ordinality as t(value, ord);
  end if;

  -- Progress and cursor advance ALWAYS run — they are the boundary's real
  -- job. 0086: the row now carries the worker-computed disposition (NULL
  -- from a caller that measures none).
  insert into screening_v2.phone_session_progress
    (session_id, question_key, question_index, source_event_id,
     first_turn_index, last_turn_index, turn_count, committed_at, disposition)
  values
    (p_session_id, p_question_key, v_cursor, p_source_event_id,
     v_base, v_base + v_count - 1, v_count, p_now, p_disposition);

  update screening_v2.call_sessions
     set current_question_index = v_cursor + 1
   where id = p_session_id
     and coalesce(current_question_index, 0) = v_cursor;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'phone question cursor CAS lost under row lock'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'applied', true,
    'duplicate', false,
    'question_key', p_question_key,
    'question_index', v_cursor,
    'first_turn_index', v_base,
    'last_turn_index', v_base + v_count - 1,
    'cursor', v_cursor + 1,
    'question_count', v_plan.question_count,
    'plan_complete', (v_cursor + 1) >= v_plan.question_count);
end;
$$;

revoke all on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, text, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_question_boundary is
  'Appends ONE completed question boundary — its progress row and cursor '
  'advance — in a single transaction under the session row lock (0086 '
  'keeps all of 0071''s behaviour). The progress row now carries the '
  'worker-computed per-key DISPOSITION (closed vocabulary, NULL = not '
  'measured), because cursor advancement must not imply asked or '
  'covered. Service-role-only.';

-- ── 3. commit_phone_question_boundary_with_coverage — 0077 body + the
--       disposition ───────────────────────────────────────────────────
-- Replaced in full. Changes from 0077: the appended `p_disposition`
-- (forwarded to the base commit, which validates it), and the
-- volunteered-coverage rows recording 'volunteered_with_evidence' — the
-- one disposition that is TRUE BY CONSTRUCTION for a forward-skip row
-- (the candidate's own words covered the objective; the ask was never
-- spoken and no synthetic bot turn is invented). Everything else is
-- byte-for-byte 0077.

drop function if exists screening_v2.commit_phone_question_boundary_with_coverage(
  uuid, text, integer, text, jsonb, text[], timestamptz);

create or replace function screening_v2.commit_phone_question_boundary_with_coverage(
  p_session_id             uuid,
  p_question_key           text,
  p_expected_index         integer,
  p_source_event_id        text,
  p_turns                  jsonb,
  p_covered_question_keys  text[] default '{}'::text[],
  p_disposition            text default null,
  p_now                    timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess screening_v2.call_sessions%rowtype;
  v_plan screening_v2.phone_session_plans%rowtype;
  v_key text;
  v_idx integer;
  v_cursor integer;
  v_first integer;
  v_last integer;
  v_count integer;
  v_result jsonb;
  v_source text;
begin
  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'unknown_session'); end if;
  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then return jsonb_build_object('status', 'plan_missing'); end if;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if p_expected_index is null or p_expected_index <> v_cursor then
    return jsonb_build_object('status', 'stale_cursor', 'cursor', v_cursor,
      'question_count', v_plan.question_count);
  end if;
  if p_covered_question_keys is null or cardinality(p_covered_question_keys) > 3 then
    return jsonb_build_object('status', 'invalid_coverage');
  end if;

  -- Validate that every volunteered key is the next contiguous plan key. This
  -- happens before the base commit so the operation cannot partially apply.
  if cardinality(p_covered_question_keys) > 0 then
    for v_idx in 1..cardinality(p_covered_question_keys) loop
      v_key := p_covered_question_keys[v_idx];
      if v_key is null or v_key !~ '^[A-Za-z0-9_.:-]{1,100}$' then
        return jsonb_build_object('status', 'invalid_coverage');
      end if;
      if v_key <> ((v_plan.questions -> (v_cursor + v_idx)) ->> 'key') then
        return jsonb_build_object('status', 'invalid_coverage', 'cursor', v_cursor);
      end if;
    end loop;
  end if;

  v_result := screening_v2.commit_phone_question_boundary(
    p_session_id, p_question_key, p_expected_index, p_source_event_id,
    p_turns, p_disposition, p_now
  );
  if coalesce(v_result ->> 'status', 'unknown_session') <> 'applied'
     or coalesce((v_result ->> 'duplicate')::boolean, false) then
    return v_result;
  end if;

  v_first := coalesce((v_result ->> 'first_turn_index')::integer, 0);
  v_last := coalesce((v_result ->> 'last_turn_index')::integer, v_first);
  v_count := v_last - v_first + 1;
  for v_idx in 1..coalesce(cardinality(p_covered_question_keys), 0) loop
    v_key := p_covered_question_keys[v_idx];
    v_source := left(p_source_event_id || ':coverage:' || md5(v_key), 200);
    insert into screening_v2.phone_session_progress
      (session_id, question_key, question_index, source_event_id,
       first_turn_index, last_turn_index, turn_count, committed_at, disposition)
    values
      (p_session_id, v_key, v_cursor + v_idx, v_source,
       v_first, v_last, v_count, p_now, 'volunteered_with_evidence');
  end loop;

  if cardinality(p_covered_question_keys) > 0 then
    -- The base RPC already advanced to v_cursor + 1. Persist the same cursor
    -- returned to the worker, including the current objective and all coverage.
    update screening_v2.call_sessions
       set current_question_index = v_cursor + 1 + cardinality(p_covered_question_keys)
     where id = p_session_id;
  end if;
  return jsonb_set(
    jsonb_set(v_result, '{cursor}', to_jsonb(v_cursor + 1 + coalesce(cardinality(p_covered_question_keys), 0))),
    '{plan_complete}', to_jsonb(v_cursor + 1 + coalesce(cardinality(p_covered_question_keys), 0) >= v_plan.question_count)
  );
exception when unique_violation then
  return jsonb_build_object('status', 'duplicate', 'duplicate', true,
    'applied', true, 'cursor', greatest(coalesce(v_sess.current_question_index, 0), 0));
end;
$$;

revoke all on function screening_v2.commit_phone_question_boundary_with_coverage(uuid, text, integer, text, jsonb, text[], text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary_with_coverage(uuid, text, integer, text, jsonb, text[], text, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_question_boundary_with_coverage is
  'Commits one real exchange and atomically advances contiguous future '
  'objectives already answered by that exchange without synthetic '
  'transcript turns (0086 keeps all of 0077''s behaviour). The main row '
  'carries the worker-computed disposition; each volunteered-coverage '
  'row records volunteered_with_evidence — true by construction for a '
  'forward-skip. Service-role-only.';
