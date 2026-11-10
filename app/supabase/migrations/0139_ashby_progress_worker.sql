-- 0139: the Ashby progress worker's database side (M031 S3).
--
-- The worker (app/api/src/integrations/ashby/progress-worker.ts, loop
-- `ashby-progress`, behind ASHBY_PROGRESS_ENABLED, off by default) re-reads
-- each imported Ashby application with application.info and
-- application.listHistory and keeps what it finds in the 0138 tables. Six
-- functions, and nothing else:
--
--   ashby_progress_covered_links        the one rule for which links the other
--                                       five seed, claim, mark and count
--   claim_ashby_progress_due            seed a progress row for every link that has
--                                       none, then claim due rows under a lease
--   record_ashby_application_progress   one application's read: progress, stage
--                                       intervals (gone_at, never deleted), the
--                                       archive reason and stages seen only in
--                                       history, in one transaction; or a failed
--                                       read, a gone application, or a row the
--                                       pass handed back unread
--   record_ashby_progress_run           one pass's counts (failures by code, and
--                                       next to them the rows it handed back
--                                       unread, `deferred`, and the passes it
--                                       skipped for the scanner just before,
--                                       `scanner_paused`); closes a backfill
--                                       whose links have all been read since
--                                       it began
--   start_ashby_progress_backfill       an admin's backfill: every link due now,
--                                       newest first, one run row, one audit row
--   ashby_progress_overview             counts only, for the admin status route
--                                       and the backfill dry run
--
-- WHICH LINKS. One rule, ashby_progress_covered_links(), used by all five:
-- every ashby_application_links row of provider ashby, except
--   - a link a data-subject erasure terminated (terminal_reason
--     'subject_erasure');
--   - a link that was ALREADY terminal (withdrawn, deleted, cancelled) and has
--     no candidate. lib/dsar.ts stamps 'subject_erasure' only on links not yet
--     terminal, then deletes the candidate: candidate_id goes NULL (on delete
--     set null) and the erasure request goes with the candidate (on delete
--     cascade). An ended link with no candidate is the only trace an erasure
--     leaves on such a link. An import cancelled before it ever became a
--     candidate drops out with it, accepted: HELLO stopped work on it;
--   - a link whose candidate has a pending, in-progress or fulfilled
--     restriction or erasure request.
-- Those are never seeded, claimed, marked or counted: their application is
-- not read from Ashby again.
--
-- THE LEASE. A claim moves next_check_at to now + the lease and answers that
-- value. The read is recorded only while next_check_at still holds it: a
-- second worker that claimed the row after the lease ran out, or a later
-- backfill that marked it due, holds a different value, and the stale read
-- is refused (`lease_lost`) without writing anything. FOR UPDATE SKIP LOCKED
-- keeps two claims running at the same instant from taking the same row; the
-- moved next_check_at keeps every later claim off it until the lease ends.
--
-- ADDITIVE ONLY. No table, column, view or existing function is created,
-- altered or dropped here. The functions write only the five 0138 tables, and
-- the backfill appends its one audit_events row (resource_update, an action
-- chk_audit_action already admits). ashby_application_links, candidates,
-- assessments and data_subject_requests are read, never written.
--
-- PRIVACY. What the API hands these functions is opaque Ashby ids, stage
-- titles, Ashby's own archive-reason catalogue, closed codes, booleans and
-- timestamps; whether a person made a move is a boolean, never the actor id.
-- The functions answer counts, codes and opaque ids only.
--
-- SECURITY (the 0138 posture): SECURITY DEFINER, pinned search_path, executable
-- by service_role only.

-- Fail fast rather than queue (the 0109 precedent). Creating functions takes
-- no lock on a table the workers write, but a stuck catalog lock must not
-- hold the deploy. LOCAL: scoped to this migration's transaction.
set local lock_timeout = '10s';

-- ═══════════════════════════════════════════════════════════════════════
-- 0. ashby_progress_covered_links: the one coverage rule
-- ═══════════════════════════════════════════════════════════════════════
-- The links the worker may read (see WHICH LINKS above): each one's id and
-- when it was imported (newest first is the read order). Created first: the
-- overview below is SQL and is checked against it when it is created. Reads
-- only.

create or replace function screening_v2.ashby_progress_covered_links()
returns table (link_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  select l.id, l.created_at
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby'
     and l.terminal_reason is distinct from 'subject_erasure'
     and (l.terminal_state is null or l.candidate_id is not null)
     and not exists (
       select 1 from screening_v2.data_subject_requests d
        where d.candidate_id = l.candidate_id
          and d.request_type in ('restrict', 'delete')
          and d.request_status in ('pending', 'in_progress', 'fulfilled'))
$$;

revoke all on function screening_v2.ashby_progress_covered_links()
  from public, anon, authenticated;
grant execute on function screening_v2.ashby_progress_covered_links()
  to service_role;

comment on function screening_v2.ashby_progress_covered_links() is
  '0139 (M031): the links the Ashby progress worker may read, as (link_id, '
  'created_at): provider ashby, not ended by a data-subject erasure, not '
  'already ended with no candidate left (what an erasure leaves on a link '
  'that was terminal before it), and no restriction or erasure request on '
  'the candidate. The one rule the claim, the run, the backfill and the '
  'overview share. Reads only. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. claim_ashby_progress_due
-- ═══════════════════════════════════════════════════════════════════════
-- Seeds first: at most p_seed_limit links with no progress row, newest
-- first, each due at or just before p_now (the newest earliest, so it is read
-- first). Then claims at most p_limit (1..50) due rows in
-- next_check_at order (a backfill orders the newest first), FOR UPDATE SKIP
-- LOCKED, moving each next_check_at to p_now + p_lease_seconds (30..3600) and
-- counting the claim in attempts. Answers the seeded count, whether a
-- backfill is open (the worker then records even an empty pass, so the
-- backfill closes) and when it began (the worker re-reads every history read
-- before then), and, per claimed row, what the worker needs to read it:
-- the progress and link ids, the Ashby application id, the lease, the stored
-- state it compares a fresh read with, and when its history was last read
-- (the newest last_seen_at of its intervals).

create or replace function screening_v2.claim_ashby_progress_due(
  p_limit         integer,
  p_lease_seconds integer,
  p_seed_limit    integer,
  p_now           timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_limit  integer := least(greatest(coalesce(p_limit, 1), 1), 50);
  v_lease  integer := least(greatest(coalesce(p_lease_seconds, 180), 30), 3600);
  v_seed   integer := least(greatest(coalesce(p_seed_limit, 0), 0), 5000);
  v_seeded integer := 0;
  v_rows   jsonb;
begin
  if v_seed > 0 then
    -- Newest link first: each seeded row is due a millisecond before the
    -- next older one, all at or before p_now.
    insert into screening_v2.ashby_application_progress
      (application_link_id, next_check_at, created_at, updated_at)
    select s.link_id, v_now - make_interval(secs => (s.total - s.rn) / 1000.0), v_now, v_now
      from (
        select t.link_id,
               row_number() over (order by t.created_at desc, t.link_id) as rn,
               count(*) over () as total
          from (
            select c.link_id, c.created_at
              from screening_v2.ashby_progress_covered_links() c
             where not exists (
                 select 1 from screening_v2.ashby_application_progress p
                  where p.application_link_id = c.link_id)
             order by c.created_at desc, c.link_id
             limit v_seed
          ) t
      ) s
    on conflict (application_link_id) do nothing;
    get diagnostics v_seeded = row_count;
  end if;

  with due as (
    select p.id, p.next_check_at as due_at
      from screening_v2.ashby_application_progress p
      join screening_v2.ashby_progress_covered_links() c on c.link_id = p.application_link_id
     where p.next_check_at <= v_now
     order by p.next_check_at, p.id
     limit v_limit
       for update of p skip locked
  ), claimed as (
    update screening_v2.ashby_application_progress p
       set next_check_at = v_now + make_interval(secs => v_lease),
           attempts      = least(p.attempts + 1, 1000000)
      from due
     where p.id = due.id
    returning p.id, p.application_link_id, p.next_check_at, p.attempts, p.status,
              p.current_stage_id, p.current_stage_entered_at, p.archived_at,
              p.ashby_updated_at, p.last_checked_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'progress_id',              c.id,
           'link_id',                  c.application_link_id,
           'application_id',           l.external_application_id,
           'lease_until',              c.next_check_at,
           'attempts',                 c.attempts,
           'status',                   c.status,
           'current_stage_id',         c.current_stage_id,
           'current_stage_entered_at', c.current_stage_entered_at,
           'archived_at',              c.archived_at,
           'ashby_updated_at',         c.ashby_updated_at,
           'last_checked_at',          c.last_checked_at,
           'history_read_at',          (select max(i.last_seen_at)
                                          from screening_v2.ashby_application_stage_intervals i
                                         where i.application_link_id = c.application_link_id))
         order by d.due_at, c.id), '[]'::jsonb)
    into v_rows
    from claimed c
    join due d on d.id = c.id
    join screening_v2.ashby_application_links l on l.id = c.application_link_id;

  return jsonb_build_object(
    'seeded', v_seeded,
    'backfill_open', exists (select 1 from screening_v2.ashby_progress_runs r
                              where r.mode = 'backfill' and r.finished_at is null),
    'backfill_started_at', (select r.started_at from screening_v2.ashby_progress_runs r
                             where r.mode = 'backfill' and r.finished_at is null
                             order by r.started_at desc limit 1),
    'claimed', v_rows);
end;
$$;

revoke all on function screening_v2.claim_ashby_progress_due(integer, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_progress_due(integer, integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_ashby_progress_due(integer, integer, integer, timestamptz) is
  '0139 (M031): seeds a progress row (due now) for up to p_seed_limit imported '
  'Ashby links that have none, newest first, then claims up to 50 due rows FOR '
  'UPDATE SKIP LOCKED in next_check_at order, moving next_check_at to the '
  'lease end and counting the claim in attempts. Only the links '
  'ashby_progress_covered_links() admits (never one a data-subject erasure '
  'ended, before or after it was terminal, or one whose candidate has a '
  'restriction or erasure request). Answers the seeded count, when the open '
  'backfill began, and per row the ids, the lease and the stored state. '
  'Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. record_ashby_application_progress
-- ═══════════════════════════════════════════════════════════════════════
-- p_result.outcome:
--   'ok'    a read. `application` holds status, current stage and job, the
--           archive reason id and type, archive time, Ashby's updatedAt and
--           when the current stage was entered; `history` is NULL when the
--           history was not read this time, else EVERY row of it; `reason`
--           is the inline archive reason, if any; `stages` are stages the
--           catalogue does not know (source 'history'); `next_check_at` is the
--           cadence the API computed. The read becomes the stored state;
--           attempts and the error code reset.
--   'error' the read failed: `error_code` (sanitized) and `next_check_at`
--           (the API's backoff). The stored state is kept.
--   'gone'  Ashby no longer has the application: the error code is stored and
--           the row is not due again (next_check_at = infinity). A backfill
--           marks it due once more.
--   'deferred' the pass handed the row back unread (its deadline or a rate
--           limit stopped it first): due again at `next_check_at`, the claim
--           refunded from attempts, and nothing else changes. updated_at does
--           not move, so a backfill still counts the row as to be read.
--
-- History: each row is upserted on Ashby's own history id, its last_seen_at
-- moved on and any gone_at cleared; a stored row this read does not return
-- (edited in Ashby) is marked gone_at, never deleted. A history row stored
-- under another link is never moved.
--
-- Stages: inserted with source 'history' and the default milestone the API
-- computed; a stage already known only from history has its missing plan
-- fields filled and, if it has no label, takes the default. A stage a plan
-- read wrote (source 'plan') is never touched.
--
-- The lease is checked first, under the row lock, and nothing is written on
-- `lease_lost` or `not_found`. Answers whether anything the impact page
-- counts changed: status, stage, job, archive reason or time, the entry time,
-- an interval added, moved, retimed or gone.

create or replace function screening_v2.record_ashby_application_progress(
  p_progress_id uuid,
  p_lease_until timestamptz,
  p_now         timestamptz,
  p_result      jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_row      screening_v2.ashby_application_progress%rowtype;
  v_outcome  text := p_result->>'outcome';
  v_app      jsonb := p_result->'application';
  v_history  jsonb := p_result->'history';
  v_reason   jsonb := p_result->'reason';
  v_stages   jsonb := coalesce(p_result->'stages', '[]'::jsonb);
  v_next     timestamptz;
  v_changed  boolean := false;
  v_n        integer := 0;
  v_moved    integer := 0;
  v_gone     integer := 0;
  v_stage_n  integer := 0;
  r          record;
begin
  if p_progress_id is null or p_lease_until is null or p_result is null or jsonb_typeof(p_result) <> 'object' then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if v_outcome is null or v_outcome not in ('ok', 'error', 'gone', 'deferred') then
    return jsonb_build_object('status', 'invalid_outcome');
  end if;
  if v_outcome in ('error', 'gone')
     and (p_result->>'error_code' is null or p_result->>'error_code' !~ '^[a-z0-9_.:-]{1,64}$') then
    return jsonb_build_object('status', 'invalid_error_code');
  end if;
  if v_outcome = 'ok' and (v_app is null or jsonb_typeof(v_app) <> 'object') then
    return jsonb_build_object('status', 'invalid_application');
  end if;
  if v_outcome = 'ok' and v_app->>'status' is not null
     and v_app->>'status' not in ('Active', 'Hired', 'Archived', 'Lead') then
    return jsonb_build_object('status', 'invalid_application');
  end if;
  if v_history is not null and jsonb_typeof(v_history) = 'null' then
    v_history := null;
  end if;
  if v_history is not null and (jsonb_typeof(v_history) <> 'array' or jsonb_array_length(v_history) > 2000) then
    return jsonb_build_object('status', 'invalid_history');
  end if;
  if jsonb_typeof(v_stages) <> 'array' or jsonb_array_length(v_stages) > 200 then
    return jsonb_build_object('status', 'invalid_stages');
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_stages) as x(default_milestone text)
     where x.default_milestone is not null
       and x.default_milestone not in ('christy','r1','r2','r3','r4','r5','reference','offer','hired','archived','other')
  ) then
    return jsonb_build_object('status', 'invalid_stages');
  end if;
  if v_outcome <> 'gone' then
    v_next := (p_result->>'next_check_at')::timestamptz;
    if v_next is null then
      return jsonb_build_object('status', 'invalid_next_check');
    end if;
  else
    v_next := 'infinity'::timestamptz;
  end if;

  -- The lease, under the row lock: a stale read writes nothing.
  select * into v_row from screening_v2.ashby_application_progress where id = p_progress_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.next_check_at is distinct from p_lease_until then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if v_outcome = 'deferred' then
    update screening_v2.ashby_application_progress set
        next_check_at = v_next,
        attempts      = greatest(attempts - 1, 0)
     where id = p_progress_id;
    return jsonb_build_object('status', 'ok', 'changed', false);
  end if;

  if v_outcome in ('error', 'gone') then
    update screening_v2.ashby_application_progress set
        check_error_code = p_result->>'error_code',
        next_check_at    = v_next,
        attempts         = case when v_outcome = 'gone' then 0 else attempts end,
        updated_at       = greatest(v_now, created_at)
     where id = p_progress_id;
    return jsonb_build_object('status', 'ok', 'changed', false);
  end if;

  -- ── The archive reason (Ashby's catalogue entry, never per-candidate text) ──
  if v_reason is not null and jsonb_typeof(v_reason) = 'object' and v_reason->>'reason_id' is not null then
    insert into screening_v2.ashby_archive_reasons as a
      (reason_id, text, reason_type, is_archived, first_seen_at, last_seen_at)
    values
      (v_reason->>'reason_id', v_reason->>'text', v_reason->>'reason_type',
       (v_reason->>'is_archived')::boolean, v_now, v_now)
    on conflict (reason_id) do update set
        text         = coalesce(excluded.text, a.text),
        reason_type  = coalesce(excluded.reason_type, a.reason_type),
        is_archived  = coalesce(excluded.is_archived, a.is_archived),
        last_seen_at = greatest(v_now, a.first_seen_at);
  end if;

  -- ── Stages the catalogue knows only from history ─────────────────────────
  for r in
    select * from jsonb_to_recordset(v_stages) as x(
      stage_id text, interview_plan_id text, title text, stage_type text,
      order_in_plan integer, stage_group_id text, default_milestone text)
  loop
    insert into screening_v2.ashby_stage_catalog as c
      (stage_id, interview_plan_id, title, stage_type, order_in_plan, stage_group_id,
       milestone, milestone_source, milestone_set_at, source, first_seen_at, last_seen_at, updated_at)
    values
      (r.stage_id, r.interview_plan_id, r.title, r.stage_type, r.order_in_plan, r.stage_group_id,
       r.default_milestone,
       case when r.default_milestone is not null then 'default' end,
       case when r.default_milestone is not null then v_now end,
       'history', v_now, v_now, v_now)
    on conflict (stage_id) do update set
        interview_plan_id = coalesce(c.interview_plan_id, excluded.interview_plan_id),
        title             = coalesce(c.title, excluded.title),
        stage_type        = coalesce(c.stage_type, excluded.stage_type),
        order_in_plan     = coalesce(c.order_in_plan, excluded.order_in_plan),
        stage_group_id    = coalesce(c.stage_group_id, excluded.stage_group_id),
        milestone         = case when c.milestone is null and c.milestone_source is distinct from 'admin'
                                 then excluded.milestone else c.milestone end,
        milestone_source  = case when c.milestone is null and c.milestone_source is distinct from 'admin'
                                 then excluded.milestone_source else c.milestone_source end,
        milestone_set_at  = case when c.milestone is null and c.milestone_source is distinct from 'admin'
                                 then excluded.milestone_set_at else c.milestone_set_at end,
        last_seen_at      = greatest(v_now, c.first_seen_at),
        updated_at        = v_now
      where c.source = 'history';
    get diagnostics v_n = row_count;
    v_stage_n := v_stage_n + v_n;
  end loop;

  -- ── The history: upsert on Ashby's id, mark the rows it no longer returns ──
  if v_history is not null then
    -- What the impact page would count differently: a new row, a row back
    -- from gone, or a row whose stage, times, position or mover changed.
    select count(*) into v_n
      from jsonb_to_recordset(v_history) as x(
             history_id text, stage_id text, entered_at timestamptz, left_at timestamptz,
             stage_number integer, moved_by_person boolean)
      left join screening_v2.ashby_application_stage_intervals i
             on i.history_id = x.history_id and i.application_link_id = v_row.application_link_id
     where i.id is null
        or i.gone_at is not null
        or (i.stage_id, i.entered_at, i.left_at, i.stage_number, i.moved_by_person)
           is distinct from (x.stage_id, x.entered_at, x.left_at, x.stage_number, x.moved_by_person);
    v_moved := v_n;

    insert into screening_v2.ashby_application_stage_intervals as i
      (application_link_id, history_id, stage_id, stage_title_seen, entered_at, left_at,
       stage_number, moved_by_person, first_seen_at, last_seen_at)
    select v_row.application_link_id, x.history_id, x.stage_id, x.title, x.entered_at, x.left_at,
           x.stage_number, x.moved_by_person, v_now, v_now
      from jsonb_to_recordset(v_history) as x(
             history_id text, stage_id text, title text, entered_at timestamptz, left_at timestamptz,
             stage_number integer, moved_by_person boolean)
    on conflict (history_id) do update set
        stage_id         = excluded.stage_id,
        stage_title_seen = coalesce(excluded.stage_title_seen, i.stage_title_seen),
        entered_at       = excluded.entered_at,
        left_at          = excluded.left_at,
        stage_number     = excluded.stage_number,
        moved_by_person  = excluded.moved_by_person,
        last_seen_at     = greatest(v_now, i.first_seen_at),
        gone_at          = null
      where i.application_link_id = excluded.application_link_id;

    -- Edited in Ashby: a stored row this read did not return. Never deleted.
    update screening_v2.ashby_application_stage_intervals i
       set gone_at = greatest(v_now, i.first_seen_at)
     where i.application_link_id = v_row.application_link_id
       and i.gone_at is null
       and not exists (
         select 1 from jsonb_to_recordset(v_history) as x(history_id text)
          where x.history_id = i.history_id);
    get diagnostics v_gone = row_count;
  end if;

  v_changed := v_moved > 0 or v_gone > 0
    or (v_row.status, v_row.current_stage_id, v_row.current_job_id, v_row.archive_reason_id,
        v_row.archive_reason_type, v_row.archived_at, v_row.current_stage_entered_at)
       is distinct from
       (v_app->>'status', v_app->>'current_stage_id', v_app->>'current_job_id', v_app->>'archive_reason_id',
        v_app->>'archive_reason_type', (v_app->>'archived_at')::timestamptz,
        (v_app->>'current_stage_entered_at')::timestamptz);

  update screening_v2.ashby_application_progress set
      status                   = v_app->>'status',
      current_stage_id         = v_app->>'current_stage_id',
      current_stage_entered_at = (v_app->>'current_stage_entered_at')::timestamptz,
      current_job_id           = v_app->>'current_job_id',
      archive_reason_id        = v_app->>'archive_reason_id',
      archive_reason_type      = v_app->>'archive_reason_type',
      archived_at              = (v_app->>'archived_at')::timestamptz,
      ashby_updated_at         = (v_app->>'ashby_updated_at')::timestamptz,
      last_checked_at          = v_now,
      next_check_at            = v_next,
      check_error_code         = null,
      attempts                 = 0,
      updated_at               = greatest(v_now, created_at)
   where id = p_progress_id;

  return jsonb_build_object('status', 'ok', 'changed', v_changed,
                            'intervals_changed', v_moved, 'intervals_gone', v_gone,
                            'stages_written', v_stage_n);
end;
$$;

revoke all on function screening_v2.record_ashby_application_progress(uuid, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.record_ashby_application_progress(uuid, timestamptz, timestamptz, jsonb)
  to service_role;

comment on function screening_v2.record_ashby_application_progress(uuid, timestamptz, timestamptz, jsonb) is
  '0139 (M031): records one progress-worker read of one imported Ashby '
  'application while its lease holds: the progress row, its stage intervals '
  '(upserted on the Ashby history id; a row a read no longer returns is '
  'marked gone_at, never deleted), the inline archive reason and stages seen '
  'only in history (source history; a plan stage is never touched); or a '
  'failed read (error code and backoff), an application Ashby no longer has '
  '(never due again), or a row handed back unread (due again, the claim '
  'refunded). One transaction. A stale lease writes nothing. Answers whether '
  'anything the impact page counts changed. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. record_ashby_progress_run
-- ═══════════════════════════════════════════════════════════════════════
-- One sweep pass: counts and failures by sanitized code, no ids. Next to the
-- failures p_errors may carry two counts that are not failures (the 0138
-- table has no column for them, and no table is altered here): `deferred`,
-- the rows the pass handed back unread (its deadline or a rate limit), and
-- `scanner_paused`, the passes the machine skipped just before it while the
-- resume scanner was short of CPU. The API reads them apart from the
-- failures. A pass that checked nothing and counted nothing writes no row
-- (the worker calls this for an empty pass only while a backfill is open, so
-- that it can close). Then,
-- if a backfill is open and every link it covers has been written by the
-- worker since it began (progress.updated_at moves only when the worker
-- records a read, a failed read or a gone application; a claim and a row
-- handed back unread leave it), it is closed: finished now, with the summed
-- counts and failures of the passes since it began.

create or replace function screening_v2.record_ashby_progress_run(
  p_started_at  timestamptz,
  p_finished_at timestamptz,
  p_checked     integer,
  p_changed     integer,
  p_errors      jsonb,
  p_now         timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_id     uuid;
  v_bf     screening_v2.ashby_progress_runs%rowtype;
  v_closed boolean := false;
  v_errors jsonb;
begin
  if p_started_at is null or p_finished_at is null or p_finished_at < p_started_at
     or p_checked is null or p_checked < 0 or p_changed is null or p_changed < 0 or p_changed > p_checked
     or p_errors is null or jsonb_typeof(p_errors) <> 'object' or octet_length(p_errors::text) > 2048 then
    return jsonb_build_object('status', 'invalid_run');
  end if;

  if p_checked > 0 or p_errors <> '{}'::jsonb then
    insert into screening_v2.ashby_progress_runs (started_at, finished_at, checked, changed, errors_by_code, mode)
    values (p_started_at, p_finished_at, p_checked, p_changed, p_errors, 'sweep')
    returning id into v_id;
  end if;

  select * into v_bf
    from screening_v2.ashby_progress_runs
   where mode = 'backfill' and finished_at is null
   order by started_at desc
   limit 1
     for update;
  if found and not exists (
    select 1
      from screening_v2.ashby_application_progress p
      join screening_v2.ashby_progress_covered_links() c on c.link_id = p.application_link_id
     where p.updated_at <= v_bf.started_at
  ) then
    select coalesce(jsonb_object_agg(t.code, t.n), '{}'::jsonb) into v_errors
      from (select e.key as code, sum((e.value #>> '{}')::bigint) as n
              from screening_v2.ashby_progress_runs s, jsonb_each(s.errors_by_code) e
             where s.mode = 'sweep' and s.started_at >= v_bf.started_at
               and jsonb_typeof(e.value) = 'number'
             group by e.key) t;
    if octet_length(v_errors::text) > 2048 then
      v_errors := jsonb_build_object('too_many_codes', 1);
    end if;
    update screening_v2.ashby_progress_runs b set
        finished_at    = greatest(v_now, b.started_at),
        checked        = (select coalesce(sum(s.checked), 0) from screening_v2.ashby_progress_runs s
                           where s.mode = 'sweep' and s.started_at >= v_bf.started_at),
        changed        = (select coalesce(sum(s.changed), 0) from screening_v2.ashby_progress_runs s
                           where s.mode = 'sweep' and s.started_at >= v_bf.started_at),
        errors_by_code = v_errors
     where b.id = v_bf.id;
    v_closed := true;
  end if;

  return jsonb_build_object('status', 'ok', 'run_id', v_id, 'backfill_finished', v_closed);
end;
$$;

revoke all on function screening_v2.record_ashby_progress_run(timestamptz, timestamptz, integer, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.record_ashby_progress_run(timestamptz, timestamptz, integer, integer, jsonb, timestamptz)
  to service_role;

comment on function screening_v2.record_ashby_progress_run(timestamptz, timestamptz, integer, integer, jsonb, timestamptz) is
  '0139 (M031): records one Ashby progress pass (mode sweep): applications '
  'checked and changed, failures by sanitized code and, next to them, the '
  'rows handed back unread (deferred) and the passes skipped for the scanner '
  'just before (scanner_paused); no ids. Closes an open '
  'backfill once every link it covers has been written since it began, with '
  'the summed counts of the passes since. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. start_ashby_progress_backfill
-- ═══════════════════════════════════════════════════════════════════════
-- An admin asks for every imported application to be read again, each with
-- its whole stage history: the claim answers when the backfill began and the
-- worker re-reads every history read before then. Idempotent:
-- while a backfill is open (not yet finished) a second call answers
-- `already_running` with that run and changes nothing. Otherwise it seeds the
-- links with no progress row, marks every covered row due now with the
-- NEWEST link first (each due a millisecond before the next older one, all
-- at or before p_now, so the worker's next_check_at order takes the newest
-- first; an application Ashby no longer has is read once more), opens one
-- backfill run (checked 0 until it closes; with no link to read it is closed
-- at once), and appends one audit_events row (resource_update, target
-- ashby_progress/backfill, counts only) under the admin, in this
-- transaction. Makes no Ashby call: the worker does the reads.

create or replace function screening_v2.start_ashby_progress_backfill(p_actor_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_open   screening_v2.ashby_progress_runs%rowtype;
  v_seeded integer := 0;
  v_marked integer := 0;
  v_links  integer := 0;
  v_run    uuid;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;

  -- One backfill at a time: a transaction-scoped advisory lock serialises two
  -- admins' clicks, so the second sees the first's open run.
  perform pg_advisory_xact_lock(hashtext('screening_v2.ashby_progress_backfill'));
  select * into v_open
    from screening_v2.ashby_progress_runs
   where mode = 'backfill' and finished_at is null
   order by started_at desc
   limit 1;
  if found then
    return jsonb_build_object('status', 'already_running', 'run_id', v_open.id, 'started_at', v_open.started_at);
  end if;

  insert into screening_v2.ashby_application_progress
    (application_link_id, next_check_at, created_at, updated_at)
  select c.link_id, v_now, v_now, v_now
    from screening_v2.ashby_progress_covered_links() c
   where not exists (
       select 1 from screening_v2.ashby_application_progress p
        where p.application_link_id = c.link_id)
  on conflict (application_link_id) do nothing;
  get diagnostics v_seeded = row_count;

  with covered as (
    select p.id, row_number() over (order by c.created_at desc, c.link_id) as rn, count(*) over () as total
      from screening_v2.ashby_application_progress p
      join screening_v2.ashby_progress_covered_links() c on c.link_id = p.application_link_id
  )
  update screening_v2.ashby_application_progress p
     set next_check_at = v_now - make_interval(secs => (c.total - c.rn) / 1000.0)
    from covered c
   where p.id = c.id;
  get diagnostics v_marked = row_count;
  v_links := v_marked;

  insert into screening_v2.ashby_progress_runs (started_at, finished_at, checked, changed, errors_by_code, mode)
  values (v_now, case when v_links = 0 then v_now end, 0, 0, '{}'::jsonb, 'backfill')
  returning id into v_run;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'resource_update', 'ashby_progress', 'backfill', 'success',
     jsonb_build_object('resource', 'ashby_progress_backfill', 'run_id', v_run,
                        'links', v_links, 'seeded', v_seeded, 'marked', v_marked));

  return jsonb_build_object('status', 'started', 'run_id', v_run, 'started_at', v_now,
                            'links', v_links, 'seeded', v_seeded, 'marked', v_marked);
end;
$$;

revoke all on function screening_v2.start_ashby_progress_backfill(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.start_ashby_progress_backfill(uuid, timestamptz)
  to service_role;

comment on function screening_v2.start_ashby_progress_backfill(uuid, timestamptz) is
  '0139 (M031): an admin backfill of the Ashby progress worker. While one is '
  'open it answers already_running and changes nothing; otherwise it seeds the '
  'missing progress rows, marks every covered row due now with the newest link '
  'first, opens one backfill run and writes its audit row (counts only) in the '
  'same transaction. Makes no Ashby call. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ashby_progress_overview
-- ═══════════════════════════════════════════════════════════════════════
-- Counts only, for GET .../progress/status and the backfill dry run. A row is
-- stale when it has been due for longer than p_stale_after_seconds and not
-- read; `gone` rows (never due) are not stale. The last sweep, and the last ten
-- runs of either mode, as counts and codes only: no id of any kind.

create or replace function screening_v2.ashby_progress_overview(p_now timestamptz, p_stale_after_seconds integer)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  with covered as (
    select c.link_id, p.id as progress_id, p.status, p.last_checked_at, p.next_check_at,
           p.check_error_code, p.updated_at
      from screening_v2.ashby_progress_covered_links() c
      left join screening_v2.ashby_application_progress p on p.application_link_id = c.link_id
  ), open_backfill as (
    select r.id, r.started_at
      from screening_v2.ashby_progress_runs r
     where r.mode = 'backfill' and r.finished_at is null
     order by r.started_at desc
     limit 1
  ), recent as (
    select r.id, r.mode, r.started_at, r.finished_at, r.checked, r.changed, r.errors_by_code
      from screening_v2.ashby_progress_runs r
     order by r.started_at desc, r.id
     limit 10
  )
  select jsonb_build_object(
    'links',          (select count(*) from covered),
    'links_excluded', (select count(*) from screening_v2.ashby_application_links l where l.provider = 'ashby')
                      - (select count(*) from covered),
    'progress_rows',  (select count(*) from covered where progress_id is not null),
    'checked',        (select count(*) from covered where last_checked_at is not null),
    'never_checked',  (select count(*) from covered where last_checked_at is null),
    'due_now',        (select count(*) from covered
                        where progress_id is null or next_check_at <= coalesce(p_now, now())),
    'gone',           (select count(*) from covered where next_check_at = 'infinity'::timestamptz),
    'stale',          (select count(*) from covered
                        where next_check_at <> 'infinity'::timestamptz
                          and next_check_at < coalesce(p_now, now())
                                              - make_interval(secs => greatest(coalesce(p_stale_after_seconds, 86400), 60))),
    'by_status',      (select jsonb_build_object(
                         'Active',   count(*) filter (where status = 'Active'),
                         'Hired',    count(*) filter (where status = 'Hired'),
                         'Archived', count(*) filter (where status = 'Archived'),
                         'Lead',     count(*) filter (where status = 'Lead'),
                         'unknown',  count(*) filter (where status is null))
                         from covered where progress_id is not null),
    'by_error',       (select coalesce(jsonb_object_agg(e.code, e.n), '{}'::jsonb)
                         from (select check_error_code as code, count(*) as n
                                 from covered where check_error_code is not null
                                group by check_error_code) e),
    'intervals',      (select jsonb_build_object(
                         'total', count(*),
                         'open',  count(*) filter (where i.left_at is null and i.gone_at is null),
                         'gone',  count(*) filter (where i.gone_at is not null))
                         from screening_v2.ashby_application_stage_intervals i
                         join covered c on c.link_id = i.application_link_id),
    'history_stages', (select count(*) from screening_v2.ashby_stage_catalog s where s.source = 'history'),
    'open_backfill',  (select jsonb_build_object(
                         'started_at', b.started_at,
                         'remaining', (select count(*) from covered c
                                        where c.progress_id is null or c.updated_at <= b.started_at))
                         from open_backfill b),
    'last_sweep',     (select jsonb_build_object(
                         'mode', s.mode, 'started_at', s.started_at, 'finished_at', s.finished_at,
                         'checked', s.checked, 'changed', s.changed, 'errors_by_code', s.errors_by_code)
                         from screening_v2.ashby_progress_runs s
                        where s.mode = 'sweep'
                        order by s.started_at desc, s.id
                        limit 1),
    'recent_runs',    (select coalesce(jsonb_agg(jsonb_build_object(
                         'mode', r.mode, 'started_at', r.started_at,
                         'finished_at', r.finished_at, 'checked', r.checked, 'changed', r.changed,
                         'errors_by_code', r.errors_by_code) order by r.started_at desc, r.id), '[]'::jsonb)
                         from recent r),
    -- Passes skipped for a CPU-starved scanner over the last day, as the
    -- passes that ran after them counted them, and when the newest ran.
    'scanner_pause',  (select jsonb_build_object(
                         'skipped_passes', coalesce(sum(floor((s.errors_by_code->>'scanner_paused')::numeric)), 0)::bigint,
                         'last_at', max(s.started_at))
                         from screening_v2.ashby_progress_runs s
                        where s.mode = 'sweep'
                          and jsonb_typeof(s.errors_by_code->'scanner_paused') = 'number'
                          and s.started_at > coalesce(p_now, now()) - interval '24 hours')
  );
$$;

revoke all on function screening_v2.ashby_progress_overview(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function screening_v2.ashby_progress_overview(timestamptz, integer)
  to service_role;

comment on function screening_v2.ashby_progress_overview(timestamptz, integer) is
  '0139 (M031): counts only for the Ashby progress status route and the '
  'backfill dry run: covered links, rows checked and never checked, due, '
  'gone, stale, by Ashby status and by error code, interval counts, history '
  'stages, the open backfill, the last sweep, the last ten runs and the passes '
  'skipped for the scanner over the last day. No id of any kind. Reads only. '
  'Service-role only.';

notify pgrst, 'reload schema';
