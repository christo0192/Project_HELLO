-- ═══════════════════════════════════════════════════════════════════════
-- 0044_phone_assessment_resume.sql
-- Phone screening P4b — durable assessment semantics, keyed resume and a
-- completion claim that cannot outrun the score.
-- ═══════════════════════════════════════════════════════════════════════
--
-- ── WHAT THIS CLOSES ──────────────────────────────────────────────────
-- P4a (0043, #97) shipped the consent gate and stopped there, truthfully:
-- the phone path persisted no transcript, activated no session, scored
-- nothing, and therefore posted `assessment.aborted` on every call. That
-- is honest and it is also useless — an engagement that always ends
-- `failed` is a screening that never happened.
--
-- 0044 makes the phone conversation DURABLE and makes the completion
-- claim CHECKABLE. Three things arrive together, deliberately, because
-- shipping any one of them alone re-creates the exact failure the other
-- two prevent:
--
--   1. An IMMUTABLE, SESSION-SCOPED QUESTION PLAN. The browser prompt
--      tells the model to "generate the actual questions LIVE", and the
--      `[MUST ASK]` items live as PROSE inside a prompt string. Prose has
--      no identity, so "never re-ask an answered question" was not
--      expressible: there was nothing for a cursor to point AT.
--      `roles.screening_template` has been a first-class, ordered,
--      id-carrying artifact since 0001 — it was simply never read by the
--      voice worker. 0044 snapshots it, once, per SESSION. A recruiter
--      editing the role mid-call cannot renumber a conversation that is
--      already in progress, and question identity is never inferred from
--      a transcript.
--
--   2. AN ATOMIC QUESTION BOUNDARY. `commit_phone_question_boundary`
--      appends the ordered turns, records the completed key and advances
--      `call_sessions.current_question_index` in ONE transaction, under
--      the session row lock. Half a boundary — turns without a cursor
--      move, or a cursor move without turns — is exactly the state a
--      reconnect would misread, so it is not reachable: any failure rolls
--      the whole boundary back.
--
--   3. AN ASSESSMENT THAT EXISTS BEFORE ANYTHING CLAIMS IT. `assessments`
--      had no uniqueness on `session_id` and `runAssessment` documented
--      its own TOCTOU race. Reconnect is precisely the condition that
--      makes that race real. A partial unique index over the PHONE
--      partition makes "scored exactly once" a database fact, and
--      `apply_phone_event` now REFUSES `assessment.completed` unless the
--      row is already there.
--
-- ── WHY THE INTERLOCK IS IN SQL, NOT IN THE WORKER ────────────────────
-- The same reason 0043 put the disclosure gate in `attach_phone_attempt_
-- recording` rather than in `phone.py`: a worker-side ordering rule is a
-- convention, and a convention survives exactly until someone reorders
-- two awaits. `assessment.completed` drives 0042 to terminal `completed`
-- with `outcome_class = 'completed'`, which every downstream reader — the
-- engagement state, P6's health backlog, the P7 calendar queue — treats
-- as a SCORED screening. That claim is unrecoverable once committed, so
-- the database refuses to record it while no assessment exists. The new
-- refusal is `assessment_missing`, and it is a REFUSAL, not a failure:
-- nothing is charged, nothing goes terminal, nothing is even recorded to
-- the ledger — because the `internal` source mints a DETERMINISTIC event
-- id, so a recorded refusal would be read back by every later delivery
-- of the same claim and a worker that posted one moment too early could
-- never complete the call at all. A re-post once scoring has landed is a
-- fresh event, and it applies.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────
--   * No new terminal reason and no new failure policy. A persistence or
--     provider failure mid-screening remains RETRYABLE through 0042's
--     existing reconnect budget; it does not invent a fresh way to end a
--     conversation. `chk_call_sessions_terminal_reason` is untouched.
--   * No stage move, no email, no scorecard write. Scoring's only
--     completion observer is the one `runAssessment` already calls.
--   * No change to the BROWSER path. `assessments.source` defaults to
--     `browser`, the new unique index is PARTIAL over `source = 'phone'`,
--     and no browser writer passes the column at all — so the browser
--     insert is byte-identical to what it was before this migration.
--   * No phone number, provider payload or raw resume is stored, read or
--     returned by anything below.
--
-- ── LOCK ORDER (extends 0042's pinned order) ──────────────────────────
--   phone_engagements -> phone_call_attempts -> call_sessions
--     -> transcript_turns -> phone_session_progress
--
-- `start_phone_assessment` is the only function that takes both an
-- engagement lock and a session lock, and it takes them in that order.
-- `commit_phone_question_boundary` takes the SESSION lock ONLY and never
-- reaches for an engagement, so the two cannot deadlock against each
-- other: a single-lock transaction cannot close a cycle, whichever end of
-- the order its one lock sits at.
--
-- ── FORWARD-ONLY, ADDITIVE ────────────────────────────────────────────
-- Two new tables, one new column with a default, one partial unique
-- index, one widened CHECK re-declared in full, three new RPCs and one
-- replaced function body. Nothing is dropped, nothing is retyped and no
-- existing row is rewritten.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. phone_session_plans — the immutable, session-scoped question plan
-- ═══════════════════════════════════════════════════════════════════════
-- ONE row per phone-screened session, written once at the first
-- assessment start and never updated. `question_key` identity comes from
-- this row and from nowhere else — never from a transcript, never from a
-- turn count, never from the model's own account of what it just asked.
--
-- The row is DELETABLE (it cascades with its session, and a data-subject
-- erasure must remain satisfiable) but not UPDATABLE. That asymmetry is
-- the point: deleting a plan removes a conversation's whole record, which
-- is visible; editing one silently renumbers a conversation in flight,
-- which is not.

create table if not exists screening_v2.phone_session_plans (
  session_id     uuid primary key
                   references screening_v2.call_sessions(id) on delete cascade,
  engagement_id  uuid not null
                   references screening_v2.phone_engagements(id) on delete cascade,
  role_id        uuid references screening_v2.roles(id) on delete set null,
  source         text not null,
  questions      jsonb not null,
  question_count integer not null,
  created_at     timestamptz not null default now(),
  constraint chk_phone_session_plans_source check (
    source in ('role_template','default')),
  constraint chk_phone_session_plans_count check (
    question_count between 1 and 100),
  -- The count is stored AND checked against the array, so a plan cannot
  -- claim a length its own questions do not have. Every cursor bound in
  -- this migration is compared against `question_count`.
  constraint chk_phone_session_plans_questions check (
    jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) = question_count)
);

create index if not exists idx_phone_session_plans_engagement
  on screening_v2.phone_session_plans (engagement_id);

comment on table screening_v2.phone_session_plans is
  'The IMMUTABLE, session-scoped snapshot of the ordered question plan a '
  'phone screening runs. Taken once, at the first assessment start, from '
  'the role''s validated screening_template — or, when that template is '
  'empty, from the deterministic default plan. A recruiter editing the '
  'role mid-call cannot renumber a conversation already in progress. '
  'Carries ordered key/text/mandatory/hint only: no phone number, no '
  'provider payload, no resume text. Service-role-only.';
comment on column screening_v2.phone_session_plans.questions is
  'Ordered array of {key,text,mandatory,hint}. `key` is the STABLE '
  'question identity the cursor and phone_session_progress point at; it '
  'is the role template''s own id, or a deterministic default_* key. It '
  'is never derived from prose and never from a turn count.';

create or replace function screening_v2.prevent_phone_plan_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'phone_session_plans is write-once: UPDATE not permitted'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_phone_session_plans_prevent_update
  on screening_v2.phone_session_plans;
create trigger trg_phone_session_plans_prevent_update
  before update on screening_v2.phone_session_plans
  for each row
  execute function screening_v2.prevent_phone_plan_update();

comment on function screening_v2.prevent_phone_plan_update is
  'Blocks UPDATE on phone_session_plans for every role, service_role '
  'included, with NO escape hatch — unlike the 0042 event ledger, which '
  'needs one for erasure. Erasure here is served by DELETE, which is '
  'deliberately still permitted so a session cascade and a data-subject '
  'request both work. A plan that can be edited is a conversation that '
  'can be silently renumbered mid-call.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. phone_session_progress — one row per COMPLETED question boundary
-- ═══════════════════════════════════════════════════════════════════════
-- A row here means: this key was asked, answered, and both halves of the
-- exchange are durable. It is written in the SAME transaction as the
-- turns it describes and the cursor advance it earns, so it can never
-- disagree with either.
--
-- Both unique constraints are FULL, not partial, and that is correct
-- rather than a departure: this table is NEW, so it has no legacy rows a
-- unique index could fail to build over. The partial-index reasoning that
-- applies to `assessments` (§3) applies to a table that already holds
-- browser data; it does not apply here.

create table if not exists screening_v2.phone_session_progress (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null
                     references screening_v2.call_sessions(id) on delete cascade,
  question_key     text not null,
  question_index   integer not null,
  -- The worker's own idempotency key for this boundary. A retry after an
  -- ambiguous response carries the SAME value and is answered with the
  -- ORIGINAL success rather than appending the exchange twice.
  source_event_id  text not null,
  first_turn_index integer not null,
  last_turn_index  integer not null,
  turn_count       integer not null,
  committed_at     timestamptz not null default now(),
  constraint uq_phone_session_progress_key
    unique (session_id, question_key),
  constraint uq_phone_session_progress_event
    unique (session_id, source_event_id),
  constraint chk_phone_session_progress_key check (
    question_key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  constraint chk_phone_session_progress_event check (
    source_event_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  constraint chk_phone_session_progress_index check (question_index >= 0),
  constraint chk_phone_session_progress_turns check (
    first_turn_index >= 0
    and last_turn_index >= first_turn_index
    and turn_count = last_turn_index - first_turn_index + 1)
);

create index if not exists idx_phone_session_progress_session
  on screening_v2.phone_session_progress (session_id, question_index);

comment on table screening_v2.phone_session_progress is
  'One row per COMPLETED question boundary on a phone screening. Written '
  'in the same transaction as the transcript turns it spans and the '
  'cursor advance it earns, so the three can never disagree. Carries no '
  'answer text — the answer is the transcript. Service-role-only.';

create or replace function screening_v2.prevent_phone_progress_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'phone_session_progress is write-once: UPDATE not permitted'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_phone_session_progress_prevent_update
  on screening_v2.phone_session_progress;
create trigger trg_phone_session_progress_prevent_update
  before update on screening_v2.phone_session_progress
  for each row
  execute function screening_v2.prevent_phone_progress_update();

comment on function screening_v2.prevent_phone_progress_update is
  'Blocks UPDATE on phone_session_progress. A committed boundary is a '
  'fact about a conversation that already happened; the only legal way '
  'to change it is to delete the session it belongs to.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. assessments — a source, and the uniqueness "score exactly once" needs
-- ═══════════════════════════════════════════════════════════════════════
-- `assessments` has carried no uniqueness on `session_id` since 0001, and
-- `services/assessment.ts` says so out loud: *"Idempotent-ish: inserts a
-- new assessment row each call"*, guarded only by a `terminal_reason`
-- flip performed AFTER the insert, with an admitted TOCTOU race. A phone
-- reconnect is exactly the condition that turns that race real.
--
-- A GLOBAL unique index is not available. Unlike a CHECK, a unique index
-- cannot be added `NOT VALID` and validated later — it builds or it
-- fails — and `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside a
-- migration transaction. If the browser's retry/reconciler path has ever
-- produced two rows for one session, a global index would simply refuse
-- to build and take the whole migration with it.
--
-- So the index is PARTIAL over the phone partition, which is empty by
-- construction on the day this applies. The preflight below is not
-- ceremony: it asserts the phone partition, and it REPORTS the browser
-- duplicate count, so an operator can see the number that would have
-- blocked a global index rather than inferring it.

alter table screening_v2.assessments
  add column if not exists source text not null default 'browser';

alter table screening_v2.assessments
  drop constraint if exists chk_assessments_source;
alter table screening_v2.assessments
  add constraint chk_assessments_source check (
    source in ('browser','phone')
  ) not valid;
alter table screening_v2.assessments
  validate constraint chk_assessments_source;

comment on column screening_v2.assessments.source is
  'Which screening channel produced this assessment. Defaults to '
  '`browser` so every pre-0044 row and every browser writer keeps its '
  'exact prior behaviour — no browser caller passes this column at all. '
  '`phone` rows are the only ones the partial unique index below '
  'constrains.';

do $$
declare
  v_phone_dupes integer;
  v_any_dupes   integer;
begin
  select count(*) into v_phone_dupes from (
    select session_id
      from screening_v2.assessments
     where source = 'phone'
     group by session_id
    having count(*) > 1) d;
  if v_phone_dupes > 0 then
    raise exception
      '0044 preflight: % session(s) already carry more than one phone assessment; uq_assessments_phone_session cannot be built',
      v_phone_dupes;
  end if;

  select count(*) into v_any_dupes from (
    select session_id
      from screening_v2.assessments
     group by session_id
    having count(*) > 1) d;
  raise notice
    '0044 preflight: % session(s) carry more than one assessment overall. The new index is PARTIAL over source = ''phone'' precisely so those cannot block the build.',
    v_any_dupes;
end;
$$;

create unique index if not exists uq_assessments_phone_session
  on screening_v2.assessments (session_id)
  where source = 'phone';

comment on index screening_v2.uq_assessments_phone_session is
  'AT MOST ONE phone-sourced assessment per session. This is what makes '
  '"scored exactly once" a database fact rather than a hope: two '
  'concurrent phone completions race the insert and exactly one wins, '
  'and the loser reuses the winner''s row instead of writing a second. '
  'PARTIAL over source = ''phone'' so pre-existing browser rows — which '
  'no constraint has ever forbidden from duplicating — cannot block the '
  'build.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. phone_default_question_plan — the fallback plan, with STABLE keys
-- ═══════════════════════════════════════════════════════════════════════
-- A role whose `screening_template` is empty is the common case today,
-- and the worker has always fallen back to the five DEFAULT_QUESTIONS in
-- `app/voice-livekit/prompting.py`. Those are prose with a numeric prefix
-- and a `[MUST ASK]` marker; here they become a plan with the SAME text,
-- the same order and the same mandatory flags, plus a stable key each.
--
-- This function is the single source of that plan. A Python drift test
-- reads THIS FILE and asserts the two agree, in both directions — a
-- second hand-maintained copy of a vocabulary is how they silently
-- diverge, and this lane has already paid for that once.

create or replace function screening_v2.phone_default_question_plan()
returns jsonb
language sql
immutable
-- SECURITY DEFINER even though it reads nothing and could safely be
-- invoker: the 0042 posture assertion allows invoker only for functions
-- on a hand-maintained helper allowlist, and widening that allowlist to
-- admit a new function weakens a tripwire that guards fourteen others.
-- A definer function returning a constant costs nothing.
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'key', 'default_intro',
      'text', 'A quick, friendly intro — like, ''So tell me a bit about yourself and what you''re working on these days.''',
      'mandatory', false,
      'hint', null),
    jsonb_build_object(
      'key', 'default_experience_years',
      'text', 'Total years of relevant experience.',
      'mandatory', true,
      'hint', null),
    jsonb_build_object(
      'key', 'default_relevant_experience',
      'text', 'Their most relevant experience for this role, adapting to the resume.',
      'mandatory', false,
      'hint', null),
    jsonb_build_object(
      'key', 'default_reason_for_leaving',
      'text', 'Reason for leaving their current or previous organization.',
      'mandatory', true,
      'hint', null),
    jsonb_build_object(
      'key', 'default_expected_ctc_notice',
      'text', 'Expected CTC, plus notice period.',
      'mandatory', true,
      'hint', null)
  )
$$;

revoke all on function screening_v2.phone_default_question_plan()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_default_question_plan()
  to service_role;

comment on function screening_v2.phone_default_question_plan is
  'The five-question fallback plan, in the order and with the mandatory '
  'flags of prompting.DEFAULT_QUESTIONS, each carrying a stable '
  '`default_*` key. Used only when a role''s screening_template is empty. '
  'A Python drift test parses this file and asserts both directions.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. get_phone_assessment_state — everything a resuming leg needs, once
-- ═══════════════════════════════════════════════════════════════════════
-- READ-ONLY, and the only read the worker performs. It returns the plan,
-- the cursor, the completed keys and the persisted turns in one answer,
-- because a resuming leg that fetched them separately could observe a
-- boundary half-committed from its own point of view even though the
-- database never held one.
--
-- It takes no clock: nothing it decides depends on time.
--
-- What it deliberately does NOT return: any phone number, SIP identifier,
-- provider payload, room name, attempt id, egress key or raw resume. The
-- `candidate_name` and `status` it does return are a strict SUBSET of the
-- worker context `resolve_worker_context` has always returned on the
-- browser path — the API layer asserts that subset structurally.

create or replace function screening_v2.get_phone_assessment_state(
  p_session_id uuid
)
returns jsonb
language plpgsql
-- Deliberately NOT declared STABLE. `start_phone_assessment` calls this
-- immediately after inserting the plan row, and a STABLE function runs
-- against the CALLING query's snapshot — which would not yet include the
-- insert this very transaction just made, so a first leg would be told
-- its own plan was missing.
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess      screening_v2.call_sessions%rowtype;
  v_plan      screening_v2.phone_session_plans%rowtype;
  v_name      text;
  v_completed jsonb;
  v_turns     jsonb;
  v_cursor    integer;
  v_next      text;
  v_scored    boolean;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_sess from screening_v2.call_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then
    -- A session with no plan has not started an assessment. Say so
    -- distinctly: the caller must call start_phone_assessment, and must
    -- NOT invent a plan of its own.
    return jsonb_build_object('status', 'plan_missing',
                              'session_status', v_sess.status);
  end if;

  select name into v_name from screening_v2.candidates
   where id = v_sess.candidate_id;

  select coalesce(jsonb_agg(p.question_key order by p.question_index), '[]'::jsonb)
    into v_completed
    from screening_v2.phone_session_progress p
   where p.session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'turn_index', t.turn_index,
           'speaker', t.speaker,
           'text', t.text) order by t.turn_index), '[]'::jsonb)
    into v_turns
    from screening_v2.transcript_turns t
   where t.session_id = p_session_id;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  -- The cursor is clamped for READING only. It is never written back
  -- here, so a row that somehow ran past its plan is reported as complete
  -- rather than silently repaired behind an operator's back.
  if v_cursor < v_plan.question_count then
    v_next := v_plan.questions -> v_cursor ->> 'key';
  else
    v_next := null;
  end if;

  select exists (
    select 1 from screening_v2.assessments a
     where a.session_id = p_session_id and a.source = 'phone')
    into v_scored;

  return jsonb_build_object(
    'status', 'ok',
    'session_id', v_sess.id,
    'session_status', v_sess.status,
    'terminal_reason', v_sess.terminal_reason,
    -- The completion path needs the REAL elapsed time. A caller with no
    -- start instant omits `duration_sec` rather than asserting zero.
    'started_at', v_sess.started_at,
    'candidate_name', v_name,
    'plan_source', v_plan.source,
    'question_count', v_plan.question_count,
    'questions', v_plan.questions,
    'cursor', v_cursor,
    'next_key', v_next,
    'completed_keys', v_completed,
    'turns', v_turns,
    'assessment_exists', v_scored,
    'plan_complete', v_cursor >= v_plan.question_count);
end;
$$;

revoke all on function screening_v2.get_phone_assessment_state(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.get_phone_assessment_state(uuid)
  to service_role;

comment on function screening_v2.get_phone_assessment_state is
  'The single read a resuming phone leg performs: plan, cursor, completed '
  'keys, persisted turns and whether a phone assessment already exists, '
  'in ONE consistent answer. Clock-free. Returns no phone number, no SIP '
  'or provider identifier, no room name, no attempt id and no raw '
  'resume. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. start_phone_assessment — bind, activate, snapshot; idempotently
-- ═══════════════════════════════════════════════════════════════════════
-- Called ONCE per leg, immediately after the disclosure gate has been
-- accepted and never before it. It does four things in one transaction:
--
--   1. Refuses unless the engagement is already `in_call` — the SAME gate
--      0043's `attach_phone_attempt_recording` uses, reachable through
--      exactly one 0042 transition (`disclosure.delivered`). A screening
--      may not begin on a call nobody consented to.
--   2. BINDS the session to the engagement and the attempt, once. The
--      binding is checked, not trusted: the session must already name
--      this exact phone room in `external_call_id` and must belong to the
--      engagement's candidate. A worker cannot hand us somebody else's
--      session.
--   3. ACTIVATES the session (`waiting` -> `in_progress`), idempotently —
--      a reconnecting leg finds it already `in_progress` and proceeds.
--   4. SNAPSHOTS the plan, once, from the role's validated
--      screening_template or from the default plan. A second leg reuses
--      the first leg's snapshot; a role edited mid-call changes nothing.
--
-- A role template that is present but MALFORMED is refused rather than
-- quietly replaced by the defaults. Screening somebody against a plan we
-- silently invented, while the recruiter believes their own questions are
-- being asked, is the worse of the two failures — and the refusal happens
-- before a single question is put, so nothing is lost but the leg.

create or replace function screening_v2.start_phone_assessment(
  p_attempt_id uuid,
  p_session_id uuid,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att       screening_v2.phone_call_attempts%rowtype;
  v_eng       screening_v2.phone_engagements%rowtype;
  v_sess      screening_v2.call_sessions%rowtype;
  v_eng_id    uuid;
  v_role_id   uuid;
  v_template  jsonb;
  v_item      jsonb;
  v_key       text;
  v_text      text;
  v_hint      text;
  v_keys      text[] := array[]::text[];
  v_questions jsonb  := '[]'::jsonb;
  v_source    text;
  v_invalid   boolean := false;
  v_exists    boolean;
  v_state     jsonb;
begin
  if p_attempt_id is null or p_session_id is null then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  -- ── Locks, in the pinned order: engagement, attempt, then session ──
  select engagement_id into v_eng_id
    from screening_v2.phone_call_attempts where id = p_attempt_id;
  if v_eng_id is null then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  select * into v_eng from screening_v2.phone_engagements
   where id = v_eng_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  select * into v_att from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal',
                              'engagement_state', v_eng.state);
  end if;

  -- THE CONSENT GATE. `in_call` is reached through exactly one 0042
  -- transition, #18 `disclosure.delivered`, and this is the second of the
  -- two locks that guard it — the worker's own gate is the first.
  if v_eng.state <> 'in_call' then
    return jsonb_build_object('status', 'disclosure_not_delivered',
                              'engagement_state', v_eng.state);
  end if;

  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- The binding is VERIFIED, never assumed. `phone-<sessionId>` is the
  -- deterministic room name the dialer provisions, and it is what the
  -- browser worker-context resolver has always checked; a session that
  -- does not carry it was not provisioned for this call.
  if v_sess.external_call_id is distinct from ('phone-' || p_session_id::text) then
    return jsonb_build_object('status', 'session_binding_mismatch');
  end if;
  if v_sess.candidate_id <> v_eng.candidate_id then
    return jsonb_build_object('status', 'session_candidate_mismatch');
  end if;
  if v_sess.status not in ('waiting','in_progress') then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;
  if v_eng.session_id is not null and v_eng.session_id <> p_session_id then
    return jsonb_build_object('status', 'session_already_bound');
  end if;
  if v_att.session_id is not null and v_att.session_id <> p_session_id then
    return jsonb_build_object('status', 'session_already_bound');
  end if;

  -- ── 2. Bind ───────────────────────────────────────────────────────
  if v_eng.session_id is null then
    update screening_v2.phone_engagements
       set session_id = p_session_id,
           version    = version + 1,
           updated_at = p_now
     where id = v_eng.id;
  end if;
  if v_att.session_id is null then
    update screening_v2.phone_call_attempts
       set session_id = p_session_id,
           room_name  = coalesce(room_name, 'phone-' || p_session_id::text)
     where id = v_att.id;
  end if;

  -- ── 3. Activate, idempotently ─────────────────────────────────────
  if v_sess.status = 'waiting' then
    update screening_v2.call_sessions
       set status = 'in_progress'
     where id = p_session_id and status = 'waiting';
    v_sess.status := 'in_progress';
  end if;

  -- ── 4. Snapshot the plan, once ────────────────────────────────────
  select exists (select 1 from screening_v2.phone_session_plans
                  where session_id = p_session_id) into v_exists;

  if not v_exists then
    v_role_id := coalesce(v_sess.role_id, v_eng.role_id);
    if v_role_id is not null then
      select screening_template into v_template
        from screening_v2.roles where id = v_role_id;
    end if;

    if v_template is null
       or jsonb_typeof(v_template) <> 'array'
       or jsonb_array_length(v_template) = 0 then
      v_questions := screening_v2.phone_default_question_plan();
      v_source    := 'default';
    elsif jsonb_array_length(v_template) > 100 then
      v_invalid := true;
    else
      v_source := 'role_template';
      for v_item in select value from jsonb_array_elements(v_template) loop
        if jsonb_typeof(v_item) <> 'object' then
          v_invalid := true;
          exit;
        end if;
        v_key  := nullif(btrim(coalesce(v_item ->> 'id', '')), '');
        v_text := nullif(btrim(coalesce(v_item ->> 'question', '')), '');
        v_hint := nullif(btrim(coalesce(v_item ->> 'follow_up_hint', '')), '');
        if v_key is null
           or v_text is null
           or v_key !~ '^[A-Za-z0-9_.:-]{1,100}$'
           or length(v_text) > 2000
           or (v_hint is not null and length(v_hint) > 2000)
           or (v_item ? 'mandatory'
               and jsonb_typeof(v_item -> 'mandatory') <> 'boolean')
           or v_key = any(v_keys) then
          v_invalid := true;
          exit;
        end if;
        v_keys := v_keys || v_key;
        v_questions := v_questions || jsonb_build_array(jsonb_build_object(
          'key', v_key,
          'text', v_text,
          'mandatory', coalesce(v_item -> 'mandatory' = 'true'::jsonb, false),
          'hint', v_hint));
      end loop;
    end if;

    if v_invalid then
      -- Refused BEFORE any question is asked, and the leg simply ends.
      -- Falling back to the defaults here would screen a candidate
      -- against questions nobody chose while the recruiter believes
      -- their own template is running.
      return jsonb_build_object('status', 'invalid_role_template');
    end if;

    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, role_id, source, questions, question_count, created_at)
    values
      (p_session_id, v_eng.id, v_role_id, v_source,
       v_questions, jsonb_array_length(v_questions), p_now)
    -- A concurrent leg may have won. The FIRST snapshot is authoritative;
    -- there is no "latest wins" here, because that is exactly how a
    -- conversation gets renumbered halfway through.
    on conflict (session_id) do nothing;
  end if;

  -- The state is read back through the SAME function the worker will call,
  -- so a resuming leg and a first leg cannot disagree about the shape of
  -- what they were given.
  v_state := screening_v2.get_phone_assessment_state(p_session_id);
  if v_state ->> 'status' <> 'ok' then
    -- The plan was written moments ago, in THIS transaction. Anything but
    -- `ok` here is a bug rather than a state, and saying so is better than
    -- dressing it up as a successful start the worker would then act on.
    return jsonb_build_object('status', 'plan_missing');
  end if;
  return v_state || jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.start_phone_assessment(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.start_phone_assessment(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.start_phone_assessment is
  'Binds a call_sessions row to a phone engagement and attempt, activates '
  'it, and snapshots the IMMUTABLE question plan — all idempotently, so a '
  'reconnecting leg re-enters and finds its own conversation. Refuses '
  'unless the engagement is already `in_call`, the same consent gate '
  '0043 puts on recording. The binding is VERIFIED against the '
  'deterministic room name and the engagement''s candidate, never taken '
  'on the worker''s word. A malformed role template is refused rather '
  'than replaced by the defaults. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. commit_phone_question_boundary — the atomic unit of a screening
-- ═══════════════════════════════════════════════════════════════════════
-- One call = one COMPLETED question: its ordered turns, its progress row
-- and its cursor advance, in one transaction under the session row lock.
--
-- ── WHY IT IS ONE CALL AND NOT THREE ──────────────────────────────────
-- Half a boundary is the state a reconnect misreads. Turns without a
-- cursor advance make the next leg re-ask a question the candidate has
-- already answered; a cursor advance without turns makes the scorer
-- assess a conversation with a hole in it. Neither is reachable: any
-- failure — a constraint violation on any turn, a lost CAS — rolls the
-- entire boundary back, and the leg re-drives it under the same
-- `source_event_id`.
--
-- ── FOLLOW-UPS RIDE INSIDE THE BOUNDARY ───────────────────────────────
-- `p_turns` is an ordered array, not a pair, so a follow-up exchange on
-- the SAME key is committed with the answer it belongs to. That is what
-- "a follow-up does not advance the cursor" means mechanically: there is
-- no call it could make that would advance it, because the only call that
-- advances the cursor is the one that closes the question.
--
-- ── THE MODEL CANNOT CHOOSE THE QUESTION ──────────────────────────────
-- `p_question_key` must equal the key the cursor is currently on. Not "a
-- key in the plan", not "an unanswered key" — the CURRENT one. A model
-- that decides to skip ahead, double back, or invent a key is refused
-- `key_not_current` and told which key it owes. Mandatory items therefore
-- cannot be skipped without a separate, deliberate migration to allow it,
-- rather than by a sampler having an off day.
--
-- ── STALE CURSORS ARE REFUSED, AND AN OMITTED CAS IS STALE ────────────
-- `p_expected_index` is a compare-and-swap, and a NULL is not a weaker
-- assertion, it is an absent one. Two legs of the same call, or a
-- resurrected leg holding a cursor from before a reconnect, must not both
-- succeed — so a null or mismatched expectation is `stale_cursor` and the
-- caller must re-read the state.

create or replace function screening_v2.commit_phone_question_boundary(
  p_session_id      uuid,
  p_question_key    text,
  p_expected_index  integer,
  p_source_event_id text,
  p_turns           jsonb,
  p_now             timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess     screening_v2.call_sessions%rowtype;
  v_plan     screening_v2.phone_session_plans%rowtype;
  v_prog     screening_v2.phone_session_progress%rowtype;
  v_item     jsonb;
  v_speaker  text;
  v_text     text;
  v_count    integer;
  v_cursor   integer;
  v_expected text;
  v_base     integer;
  v_updated  integer;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- The SESSION row lock, and nothing above it. This function never
  -- reaches for an engagement, so its lock set is a strict prefix of
  -- start_phone_assessment's and the two cannot deadlock.
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

  -- ── SHAPE FIRST ────────────────────────────────────────────────────
  -- Validated BEFORE the duplicate read-back, so a malformed body carrying
  -- a known event id is answered `invalid_turns` rather than `applied`.
  -- Nothing is written either way, so this is about the answer being
  -- truthful rather than about safety: a caller told `applied` for an
  -- exchange this function never even parsed has been told something
  -- false about its own request.
  if p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_question_key is null
     or p_turns is null
     or jsonb_typeof(p_turns) <> 'array' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;
  v_count := jsonb_array_length(p_turns);
  -- At least one ask and one answer; at most six exchanges, which is the
  -- bound on how much follow-up one question may absorb before the
  -- boundary has to close.
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
  end loop;
  -- A boundary opens with the ask and closes with the answer. Anything
  -- else is not a completed question.
  if (p_turns -> 0 ->> 'speaker') <> 'bot'
     or (p_turns -> (v_count - 1) ->> 'speaker') <> 'candidate' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  -- ── DUPLICATE NEXT, AND BEFORE THE ACTIVE-SESSION CHECK ───────────
  -- A worker whose response was lost retries with the same id. If the
  -- call has since been completed, refusing here would leave the worker
  -- unable to tell "already recorded" from "never recorded" on the one
  -- boundary it cares most about. So an already-committed boundary is
  -- answered with the ORIGINAL success, whatever the session has since
  -- become.
  if true then
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
  end if;

  if v_sess.status <> 'in_progress' then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  -- ── The cursor, and the key it owes ───────────────────────────────
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

  -- ── Append. One statement, so a bad turn takes the whole set ──────
  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, created_at)
  select p_session_id,
         v_base + (t.ord - 1)::integer,
         t.value ->> 'speaker',
         btrim(t.value ->> 'text'),
         p_now
    from jsonb_array_elements(p_turns) with ordinality as t(value, ord);

  insert into screening_v2.phone_session_progress
    (session_id, question_key, question_index, source_event_id,
     first_turn_index, last_turn_index, turn_count, committed_at)
  values
    (p_session_id, p_question_key, v_cursor, p_source_event_id,
     v_base, v_base + v_count - 1, v_count, p_now);

  update screening_v2.call_sessions
     set current_question_index = v_cursor + 1
   where id = p_session_id
     and coalesce(current_question_index, 0) = v_cursor;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    -- Unreachable while the row lock above is held, and asserted rather
    -- than assumed: if it ever fires, the turns and the progress row this
    -- transaction wrote are rolled back with it, which is the only safe
    -- direction. It is a raise rather than a returned status precisely
    -- because a status would COMMIT the half-boundary it is reporting.
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

revoke all on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_question_boundary is
  'Appends ONE completed question boundary — its ordered turns, its '
  'progress row and its cursor advance — in a single transaction under '
  'the session row lock. A duplicate source_event_id returns the ORIGINAL '
  'success; a null or mismatched expected index is stale_cursor; a key '
  'that is not the one the cursor owes is key_not_current, so a model can '
  'neither skip a mandatory question nor claim another one. Any failure '
  'rolls the whole boundary back — half a boundary is the state a '
  'reconnect misreads. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. RLS and grants — service-role-only, exactly as 0042
-- ═══════════════════════════════════════════════════════════════════════
-- No policy for anon or authenticated. A question plan plus a progress
-- trail is a re-identifiable record of a specific person's screening.

alter table screening_v2.phone_session_plans    enable row level security;
alter table screening_v2.phone_session_progress enable row level security;

revoke all on screening_v2.phone_session_plans    from anon, authenticated, public;
revoke all on screening_v2.phone_session_progress from anon, authenticated, public;

grant all privileges on screening_v2.phone_session_plans    to service_role;
grant all privileges on screening_v2.phone_session_progress to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. apply_phone_event -- ONE new guard, everything else byte-identical
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced rather than patched, because a CHECK-style in-place edit does
-- not exist for a function body. The ONLY difference from 0043 is the
-- guard inside the `in_call` + `assessment.completed` branch; a drift
-- test diffs this body against 0043's and asserts that the guard is the
-- sole change.
--
-- Everything 0042 and 0043 established is preserved verbatim: the
-- deterministic synthetic provider_event_id, the verdict decided BEFORE
-- anything is written, the single insert already carrying its outcome,
-- the duplicate read-back, the `attempt_required` refusal, the three
-- independent budgets, and the suppression written in the SAME
-- transaction as the terminal opt-out that earns it.

create or replace function screening_v2.apply_phone_event(
  p_source            text,
  p_event_type        text,
  p_attempt_id        uuid        default null,
  p_engagement_id     uuid        default null,
  p_provider_event_id text        default null,
  p_epoch             integer     default null,
  p_metadata          jsonb       default null,
  p_now               timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att        screening_v2.phone_call_attempts%rowtype;
  v_eng        screening_v2.phone_engagements%rowtype;
  v_eng_id     uuid;
  v_subject    text;
  v_event_id   text;
  v_ignored    text;
  v_new_state  text;        -- engagement target, null = no engagement change
  v_att_state  text;        -- attempt target, null = no attempt change
  v_outcome    text;
  v_charge     text;        -- 'no_answer' | 'reconnect' | 'provider' | null
  v_reason     text;
  v_bump_epoch boolean := false;
  v_defer      boolean := false;
  v_row_id     uuid;
  v_existing   screening_v2.phone_call_events%rowtype;
  v_slot_start timestamptz;
  v_metadata   jsonb;
  v_phone      text;
  v_digest     text;
  v_suppressed boolean := false;
  v_defer_at   timestamptz;
  -- 0044: set by the one edge whose claim must be backed by a real score.
  v_needs_assessment boolean := false;
begin
  if p_source is null or p_source not in
     ('livekit_webhook','provider_callback','provider_poll','internal','reconciliation') then
    return jsonb_build_object('status', 'invalid_source');
  end if;

  -- Unsanitized metadata is DROPPED, not stored and not fatal. Refusing
  -- the whole call would lose the event, and the ledger exists to record
  -- events; storing it would durably persist a provider envelope on an
  -- append-only table. The replacement marker says plainly that
  -- something was discarded, so this is visible rather than silent.
  v_metadata := case
    when screening_v2.phone_event_metadata_sanitized(p_metadata) then p_metadata
    else jsonb_build_object('metadata_rejected', true)
  end;
  if p_event_type is null or p_event_type !~ '^[a-z][a-z0-9_.]{1,63}$' then
    return jsonb_build_object('status', 'invalid_event_type');
  end if;

  -- ── Resolve the subject, taking locks in the pinned order ──────────
  if p_attempt_id is not null then
    select engagement_id into v_eng_id
      from screening_v2.phone_call_attempts where id = p_attempt_id;
  else
    v_eng_id := p_engagement_id;
  end if;

  if v_eng_id is not null then
    select * into v_eng from screening_v2.phone_engagements
     where id = v_eng_id for update;
    if not found then
      v_eng_id := null;
    end if;
  end if;
  if p_attempt_id is not null and v_eng_id is not null then
    select * into v_att from screening_v2.phone_call_attempts
     where id = p_attempt_id for update;
  end if;

  -- ── The deterministic synthetic id ─────────────────────────────────
  -- provider_event_id is NOT NULL on the table, because a unique index
  -- over a nullable column does not dedup and the non-provider channels
  -- are exactly the ones that recover a dropped webhook.
  v_subject := coalesce(p_attempt_id::text, v_eng_id::text, 'unbound');
  if p_provider_event_id is not null then
    v_event_id := p_provider_event_id;
  elsif p_source = 'internal' then
    v_event_id := 'internal:' || v_subject || ':' || p_event_type
                  || ':' || coalesce(p_epoch, -1)::text;
  elsif p_source = 'provider_poll' then
    v_event_id := 'poll:' || v_subject || ':' || p_event_type;
  elsif p_source = 'reconciliation' then
    v_event_id := 'recon:' || v_subject || ':' || p_event_type;
  else
    -- A webhook or provider callback with no provider id is not
    -- dedupable and must not be silently invented.
    return jsonb_build_object('status', 'provider_event_id_required');
  end if;
  if v_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$' then
    return jsonb_build_object('status', 'invalid_provider_event_id');
  end if;

  -- ── The verdict, decided BEFORE anything is written ────────────────
  if v_eng_id is null or (p_attempt_id is not null and v_att.id is null) then
    v_ignored := 'unknown_attempt';
  elsif v_eng.terminal_at is not null then
    v_ignored := 'terminal';
  -- Fencing must not be optional. An ingress that omits its epoch is
  -- fenced against the epoch stored ON THE ATTEMPT, which #18 keeps in
  -- step with the engagement's. Without this fallback a callback
  -- belonging to a superseded conversation and carrying no epoch applied
  -- against the NEW one — charging a reconnect on a call still up.
  elsif coalesce(p_epoch, v_att.epoch) is not null
        and coalesce(p_epoch, v_att.epoch) < v_eng.epoch then
    v_ignored := 'stale_epoch';
  else
    case
      -- ── from `dialing` ──────────────────────────────────────────────
      when v_eng.state = 'dialing' and p_event_type = 'sip.participant_joined' then
        -- #14. JOIN IS NOT ANSWER. The SIP leg being up says nothing
        -- about who, or what, is on it. No assessment, no egress, no
        -- agent speech may follow from this state.
        v_att_state := 'answered_unclassified';
      when v_eng.state = 'dialing' and p_event_type = 'classify.human' then
        v_att_state := 'human';                                        -- #16
      when v_eng.state = 'dialing' and p_event_type = 'classify.machine' then
        -- #15. A voicemail must produce NO scored session: it charges a
        -- no-answer attempt, never a reconnect, and the attempt ends.
        v_att_state := 'ended'; v_outcome := 'voicemail'; v_charge := 'no_answer';
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_busy' then
        v_att_state := 'ended'; v_outcome := 'busy'; v_charge := 'no_answer';   -- #11
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_timeout' then
        v_att_state := 'ended'; v_outcome := 'no_answer'; v_charge := 'no_answer'; -- #12
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_transport' then
        v_att_state := 'ended'; v_outcome := 'provider_error'; v_charge := 'provider'; -- #13
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.refused' then
        -- #17. Terminal, and the purge/suppression that must accompany
        -- it is P4's transaction, not this one.
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';
        v_reason := 'disclosure_refused';
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.delivered' then
        -- #18. The ONLY place a conversation begins: bump the fencing
        -- epoch and reset the reconnect budget for the new conversation.
        v_new_state := 'in_call'; v_bump_epoch := true;
      when v_eng.state = 'dialing' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number';
        v_reason := 'wrong_number';

      -- ── from `dialing`, ANSWERED but PRE-DISCLOSURE (0043 / P3-1) ───
      -- The gap P3 recorded and could not close: a candidate who PICKS UP
      -- and hangs up before `disclosure.delivered` left the engagement in
      -- `dialing` with the attempt in `answered_unclassified`/`human` and
      -- NO legal edge, so the drop was recorded as `unexpected_event` and
      -- the outcome was unrecorded rather than classified.
      --
      -- Three things make this branch truthful rather than convenient:
      --
      --   * IT IS GATED ON THE ATTEMPT, NOT THE ENGAGEMENT. `dialing`
      --     OUTLIVES THE ANSWER (0042 #14: join is not answer), so the
      --     engagement state alone cannot tell a leg that rang out from a
      --     leg somebody picked up. Only `answered_unclassified` and
      --     `human` reach here; `admitted`/`ringing` fall through to the
      --     §4 default exactly as before. Calling an unanswered drop
      --     "abandoned" would be the mirror of the P3 HIGH that called an
      --     answered call `no_answer`.
      --   * IT CHARGES NOTHING. No no-answer budget, no reconnect budget,
      --     no provider budget. A hangup during our own identity line is
      --     not evidence the line is bad, and a reconnect grant is exactly
      --     what `reconnects_used` records -- an "uncharged reconnect" is
      --     not a thing. The engagement returns to `eligible`, a legal
      --     edge out of `dialing`.
      --   * IT IS BOUNDED BY AN INDEX THAT ALREADY EXISTS, not by a new
      --     counter. The attempt keeps today's `ist_date` and its
      --     `initial`/`no_answer_retry`/`scheduled` kind, so
      --     `uq_phone_attempts_one_per_ist_day` refuses the next admission
      --     with `daily_attempt_exists` until the IST day rolls. A gating
      --     counter with no reset lifecycle is the one-way latch this
      --     project has already paid for twice; the per-day index needs no
      --     lifecycle because the day supplies it.
      --
      -- `next_eligible_at` is moved to the next legal instant on the next
      -- IST day for the same reason the provider path does it: the row
      -- must say out loud when it may next be tried rather than looking
      -- eligible now and being refused by an index.
      --
      -- `candidate.deferred_pre_disclosure` is the THIRD member and the one
      -- that is not a hangup: the candidate answered, said "call me later",
      -- and asked for it BEFORE the disclosure. It shares this branch because
      -- it shares every property that matters -- the attempt ends, nothing is
      -- charged, and the engagement leaves `dialing` for a legal state. It is
      -- a DISTINCT event type rather than a reused `sip.participant_left`
      -- because posting "the participant left" about somebody still holding
      -- the handset would be false, and the ledger is the place an operator
      -- goes to find out what actually happened.
      --
      -- It exists because `schedule_phone_appointment` refuses outright while
      -- the engagement is `dialing` (`attempt_in_flight`) -- a live dial owns
      -- the engagement, and rescheduling under it would put the calendar and
      -- the wire into disagreement. So a pre-disclosure "later" must FIRST
      -- end the attempt truthfully and uncharged, and only then book from a
      -- legal state. The alternative -- relaxing the guard -- would trade a
      -- real invariant for the convenience of one code path.
      --
      -- Idempotency needs no special handling. A redelivery carrying the
      -- same `provider_event_id` hits `uq_phone_call_events_provider` and
      -- is answered with the ORIGINAL verdict; a genuinely distinct second
      -- event finds the engagement in `eligible`, matches no branch and is
      -- recorded as `unexpected_event`. Neither loops.
      when v_eng.state = 'dialing'
           and p_event_type in ('sip.participant_left','sip.connection_aborted',
                                'candidate.deferred_pre_disclosure')
           and v_att.state in ('answered_unclassified','human') then
        v_att_state := 'ended'; v_outcome := 'abandoned_pre_disclosure';
        v_new_state := 'eligible'; v_reason := 'abandoned_pre_disclosure';
        v_defer_at  := screening_v2.phone_next_window_open(
                         (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                           at time zone 'Asia/Kolkata');

      -- ── from `in_call` ──────────────────────────────────────────────
      when v_eng.state = 'in_call'
           and p_event_type in ('sip.participant_left','sip.connection_aborted') then
        v_att_state := 'ended'; v_outcome := 'disconnected';
        if v_eng.reconnects_used >= 3 then
          -- #21. Three reconnects have already been GRANTED and used;
          -- this drop earns no fourth. Terminal, and no further charge —
          -- `reconnecting` with an unredeemable budget would be a state
          -- with no outgoing edge and nothing left to drive it.
          v_new_state := 'failed'; v_reason := 'reconnect_budget_exhausted';
        elsif screening_v2.phone_ist_window_open(p_now) then
          -- #19. The charge happens HERE, at the grant, not at the dial:
          -- `reconnects_used` counts drops that have been granted a
          -- reconnect, and the grant that takes it to 3 is precisely the
          -- one being redeemed by the next admission.
          v_new_state := 'reconnecting'; v_charge := 'reconnect';
        else
          -- #20. The boundary is evaluated when the reconnect would be
          -- ACTED ON, not when the disconnect happened. A wait outside
          -- the window charges NOTHING and is deferred to a real slot.
          v_new_state := 'scheduled'; v_defer := true; v_reason := 'window_closed';
        end if;
      when v_eng.state = 'in_call' and p_event_type = 'assessment.completed' then
        -- #22, WITH THE 0044 INTERLOCK (enforced below, before the insert).
        v_new_state := 'completed'; v_att_state := 'ended'; v_outcome := 'completed';
        v_needs_assessment := true;
      when v_eng.state = 'in_call' and p_event_type = 'assessment.aborted' then
        -- Every other `ended` path names an outcome; an operator
        -- filtering on outcome_class must not lose these rows.
        v_new_state := 'failed'; v_att_state := 'ended'; v_outcome := 'disconnected';
        v_reason := 'assessment_aborted';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number'; -- #23
        v_reason := 'wrong_number';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.opt_out' then
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24
        v_reason := 'candidate_opt_out';

      -- ── from `awaiting_retry` ───────────────────────────────────────
      -- #28 has no branch here on purpose. The no-answer charge that
      -- lands on 3 goes STRAIGHT to `abandoned_no_answer` (below), so an
      -- `awaiting_retry` engagement always has budget left and a
      -- `budget.exhausted` branch could never fire. An unreachable
      -- branch reads as a safety net and is not one.
      when v_eng.state = 'awaiting_retry' and p_event_type = 'day.rolled'
           and screening_v2.phone_ist_date(p_now)
               > screening_v2.phone_ist_date(coalesce(v_eng.last_attempt_at, p_now)) then
        v_new_state := 'eligible';                                      -- #27

      -- ── from `pending_prereqs` ──────────────────────────────────────
      when v_eng.state = 'pending_prereqs' and p_event_type = 'prereq.satisfied' then
        -- #2. Advisory only: every prerequisite is RE-CHECKED, under a
        -- lock, inside admit_phone_attempt. This edge cannot authorise a
        -- dial on its own.
        v_new_state := 'eligible';

      -- ── from any non-terminal state ─────────────────────────────────
      when p_event_type in ('hr.cancelled','emergency.stop','ashby.stage_left','prereq.lost') then
        v_new_state := 'cancelled';                                     -- #3 / #29
        v_reason    := replace(p_event_type, '.', '_');
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'cancelled';
        end if;

      else
        v_ignored := 'unexpected_event';                                -- the §4 default
    end case;
  end if;

  -- ── An engagement-scoped post cannot drive an attempt-scoped edge ──
  -- Both attempt writes below are guarded by `v_att.id is not null`, and
  -- a guard that SKIPS is not a guard: the engagement half of the
  -- transition would still be applied. `classify.machine` posted with
  -- only an engagement id would charge a no-answer attempt and move to
  -- `awaiting_retry` while leaving the attempt live and holding a fleet
  -- slot; `disclosure.delivered` would bump the engagement's epoch and
  -- not the attempt's, fencing out every later event on that attempt and
  -- leaving a conversation nothing could end.
  --
  -- So the requirement is decided WITH the verdict, before anything is
  -- written, and answered with a stable refusal. Nothing is recorded:
  -- this is a malformed call, not an event that happened.
  if v_ignored is null and v_att.id is null
     and (v_att_state is not null or v_bump_epoch) then
    return jsonb_build_object('status', 'attempt_required',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── 0044: A COMPLETION CLAIM MUST BE BACKED BY A REAL SCORE ────────
  -- `assessment.completed` takes the engagement to terminal `completed`
  -- with outcome_class = 'completed', which the engagement state, P6's
  -- health backlog and the P7 calendar queue all read as a SCORED
  -- screening. That claim is unrecoverable once committed, so it is
  -- checked here rather than trusted from the worker — the same reason
  -- 0043 put the disclosure gate in attach_phone_attempt_recording
  -- instead of in phone.py: a worker-side ordering rule survives exactly
  -- until someone reorders two awaits.
  --
  -- IT IS A PRE-INSERT REFUSAL, AND THAT IS THE WHOLE POINT. The
  -- `internal` source mints a DETERMINISTIC provider_event_id, so a
  -- recorded refusal would be read back verbatim by every later delivery
  -- of the same claim — and a worker that posted one moment too early
  -- could then never complete the call at all. Recording this would turn
  -- a retryable timing problem into a permanent wedge. So nothing is
  -- written, exactly as for `attempt_required` above, and a re-post once
  -- scoring has landed is a fresh event that applies.
  --
  -- Nothing is charged either: the engagement stays precisely where it
  -- was, with every budget untouched.
  if v_ignored is null and v_needs_assessment
     and (v_eng.session_id is null
          or not exists (
            select 1 from screening_v2.assessments a
             where a.session_id = v_eng.session_id
               and a.source = 'phone')) then
    return jsonb_build_object('status', 'assessment_missing',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── One INSERT, already carrying the final verdict ─────────────────
  insert into screening_v2.phone_call_events
    (source, provider_event_id, engagement_id, attempt_id, epoch, event_type,
     received_at, applied, ignored_reason, metadata, created_at)
  values
    (p_source, v_event_id,
     case when v_ignored = 'unknown_attempt' then null else v_eng_id end,
     case when v_ignored = 'unknown_attempt' then null else p_attempt_id end,
     p_epoch, p_event_type, p_now, v_ignored is null, v_ignored, v_metadata, p_now)
  on conflict do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- A duplicate delivery. Read back the ORIGINAL row and hand the
    -- caller exactly the answer the first delivery received, so a
    -- webhook retry storm converges instead of diverging.
    select * into v_existing from screening_v2.phone_call_events
     where source = p_source and provider_event_id = v_event_id;
    return jsonb_build_object(
      'status', case when v_existing.applied then 'applied' else 'ignored' end,
      'applied', v_existing.applied,
      'ignored_reason', v_existing.ignored_reason,
      'event_id', v_existing.id,
      'duplicate', true);
  end if;

  if v_ignored is not null then
    return jsonb_build_object('status', 'ignored', 'applied', false,
                              'ignored_reason', v_ignored,
                              'event_id', v_row_id, 'duplicate', false);
  end if;

  -- ── Apply. Budgets move HERE and nowhere else ──────────────────────
  if v_charge = 'no_answer' then
    if v_eng.no_answer_attempts + 1 >= 3 then
      v_new_state := 'abandoned_no_answer'; v_reason := 'no_answer_budget_exhausted';
    else
      v_new_state := 'awaiting_retry';
    end if;
  elsif v_charge = 'provider' then
    if v_eng.provider_failures + 1 >= 5 then
      v_new_state := 'failed'; v_reason := 'provider_budget_exhausted';
    else
      -- THE PROVIDER BUDGET IS PACED BY THE IST DAY, DELIBERATELY.
      -- The engagement returns to `eligible`, but the failed attempt
      -- keeps kind='initial'/'no_answer_retry' and today's ist_date, so
      -- uq_phone_attempts_one_per_ist_day refuses the next admission
      -- with `daily_attempt_exists` until the IST day rolls. Exhausting
      -- the five-failure budget therefore takes up to five IST days.
      --
      -- That is the choice, not an accident. The alternative — letting a
      -- provider error free the day — would mean an engagement could be
      -- dialled up to six times in one day whenever our transport was
      -- flaky, and the per-day index is an ANTI-HARASSMENT invariant.
      -- We cannot tell from a transport rejection whether the line rang;
      -- fail closed on that uncertainty, at the cost of throughput and
      -- never at the candidate's.
      --
      -- `next_eligible_at` is set to the next legal instant on the next
      -- IST day so the row says out loud when it may next be tried,
      -- rather than looking eligible now and being refused by an index.
      v_new_state := 'eligible';
      v_defer_at  := screening_v2.phone_next_window_open(
                       (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                         at time zone 'Asia/Kolkata');
    end if;
  end if;

  -- #18 bumps the engagement's fencing epoch; the LIVE attempt must
  -- carry the new value, or the fallback above would fence the very
  -- conversation that just started.
  if v_bump_epoch then
    update screening_v2.phone_call_attempts
       set epoch = v_eng.epoch + 1
     where id = v_att.id;
  end if;

  if v_att_state is not null then
    update screening_v2.phone_call_attempts
       set state         = v_att_state,
           outcome_class = coalesce(v_outcome, outcome_class),
           answered_at   = case when v_att_state = 'answered_unclassified'
                                then coalesce(answered_at, p_now) else answered_at end,
           classified_at = case when v_att_state in ('human','machine')
                                then coalesce(classified_at, p_now) else classified_at end,
           ended_at      = case when v_att_state = 'ended' then p_now else ended_at end,
           -- An ended attempt releases its fleet slot immediately; a
           -- freed slot must not wait for a lease to lapse.
           lease_token   = case when v_att_state = 'ended' then null else lease_token end,
           lease_owner   = case when v_att_state = 'ended' then null else lease_owner end
     where id = v_att.id;
  end if;

  -- #20: a window-closed reconnect is parked on a real, legal slot
  -- rather than on a state that merely claims to be scheduled.
  if v_defer then
    v_slot_start := screening_v2.phone_next_window_open(p_now);
    insert into screening_v2.phone_appointments
      (engagement_id, starts_at, ends_at, ist_date, status, source,
       created_by, created_at, updated_at)
    values
      (v_eng.id, v_slot_start, v_slot_start + interval '30 minutes',
       screening_v2.phone_ist_date(v_slot_start), 'scheduled', 'system_deferral',
       '00000000-0000-0000-0000-000000000000'::uuid, p_now, p_now)
    on conflict do nothing;
  end if;

  if v_new_state is not null then
    update screening_v2.phone_engagements
       set state           = v_new_state,
           state_reason    = coalesce(v_reason, state_reason),
           epoch           = case when v_bump_epoch then epoch + 1 else epoch end,
           -- THE reconnect budget. It is reset only when a genuinely NEW
           -- conversation begins — an `initial`, `no_answer_retry` or
           -- `scheduled` dial. Resetting it on a RECONNECT's disclosure
           -- would make "max 3 reconnects" unenforceable: every
           -- reconnect that reached in_call would zero the counter, so
           -- it could never exceed 1, the reconnect-exhaustion refusal
           -- and the #21 `failed` edge would both be dead code, and a
           -- flapping line could be re-dialled without limit. On a
           -- BILLABLE dialer that is the bound that must actually hold.
           reconnects_used = case
                               when v_bump_epoch
                                    and coalesce(v_att.kind, 'initial') <> 'reconnect'
                                 then 0
                               when v_charge = 'reconnect' then reconnects_used + 1
                               else reconnects_used end,
           no_answer_attempts = case when v_charge = 'no_answer'
                                     then no_answer_attempts + 1 else no_answer_attempts end,
           provider_failures  = case when v_charge = 'provider'
                                     then provider_failures + 1 else provider_failures end,
           terminal_at     = case
                               when v_new_state in ('completed','abandoned_no_answer',
                                                    'opted_out','wrong_number','failed','cancelled')
                               then p_now else null end,
           next_eligible_at = case
                                when v_defer then v_slot_start
                                when v_defer_at is not null then v_defer_at
                                else next_eligible_at end,
           version          = version + 1,
           updated_at       = p_now
     where id = v_eng.id;
  end if;
  -- There is deliberately no "charged but no state change" branch: every
  -- path that sets v_charge also sets v_new_state, so such a branch would
  -- be unreachable code pretending to be a safety net.

  -- ── Audit only the outcomes an operator must be able to find ───────
  if v_att_state in ('human','machine') then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_attempt_classified', 'phone_call_attempt', v_att.id::text, 'success',
       jsonb_build_object('engagement_id', v_eng.id, 'classification', v_att_state,
                          'event_type', p_event_type));
  end if;
  -- ── THE SUPPRESSION IS PART OF THE OPT-OUT, NOT A FOLLOW-UP ────────
  -- An opt-out modelled only on the engagement is enforced PER
  -- APPLICATION: the same person applying to a second role would be
  -- dialled again, because the second engagement has its own terminal
  -- state and knows nothing about the first. The obligation follows the
  -- LINE, so it is recorded against the line's digest, and it is
  -- recorded in THIS transaction — a terminal transition that commits
  -- without its suppression is the split this substrate exists to
  -- prevent, and a deferred obligation is documentation, not a control.
  if v_new_state in ('opted_out','wrong_number') then
    select phone_e164 into v_phone
      from screening_v2.candidates where id = v_eng.candidate_id;

    if v_phone is not null then
      v_digest := screening_v2.sha256_hex(v_phone);
      insert into screening_v2.phone_suppressions
        (candidate_id, phone_sha256, reason, source, created_at)
      values
        (v_eng.candidate_id, v_digest,
         case when v_new_state = 'opted_out' then 'candidate_opt_out' else 'wrong_number' end,
         'candidate', p_now)
      -- The line may already be suppressed from an earlier application.
      -- That is the mechanism working, not a conflict to resolve.
      on conflict (phone_sha256) do nothing;
      v_suppressed := true;

      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
         'phone_suppression_added', 'phone_suppression', v_digest, 'success',
         -- The DIGEST is the target id, and there is no number anywhere
         -- in this row. That is the whole point of keying on a digest.
         jsonb_build_object('engagement_id', v_eng.id,
                            'reason', case when v_new_state = 'opted_out'
                                           then 'candidate_opt_out' else 'wrong_number' end,
                            'source', 'candidate'));
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      -- The one place `candidate` is the truthful actor type: the
      -- outcome originated with the person on the line.
      ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
       'phone_opt_out_recorded', 'phone_engagement', v_eng.id::text, 'success',
       -- `suppression_written` is read from what actually happened. An
       -- engagement with no number on record CANNOT suppress a line it
       -- does not know, and saying so is better than implying a control
       -- that was not applied. Such an engagement is also undialable
       -- (admission refuses `phone_invalid`), so the two facts are
       -- coherent — but an operator must be able to see the gap.
       jsonb_build_object('outcome', v_new_state, 'reason', v_reason,
                          'event_type', p_event_type,
                          'suppression_written', v_suppressed));
  end if;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'ignored_reason', null,
                            'event_id', v_row_id, 'duplicate', false,
                            'engagement_state', coalesce(v_new_state, v_eng.state),
                            'attempt_state', coalesce(v_att_state, v_att.state));
end;
$$;

-- Grants are preserved by `create or replace`, but they are re-issued here
-- so this file states the whole privilege story of the function it ships.
revoke all on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz) to service_role;

comment on function screening_v2.apply_phone_event is
  'Insert-once ingress apply path for phone call events, replaced by 0044 '
  'to add ONE guard: `assessment.completed` is refused '
  '`assessment_missing` unless a phone-sourced assessment row already '
  'exists for the engagement''s bound session. That edge is terminal and '
  'unrecoverable, and every downstream reader treats it as a scored '
  'screening, so the claim is checked in SQL rather than trusted from a '
  'worker. Like `attempt_required`, the refusal is decided BEFORE the '
  'insert and writes NO ledger row — the deterministic internal event id '
  'would otherwise pin the refusal forever and wedge the call. It is '
  'free: no budget moves, no state changes, and a re-post after scoring '
  'lands succeeds. Everything else — the '
  'deterministic synthetic provider_event_id, the verdict decided before '
  'anything is written, the single insert already carrying its outcome, '
  'the duplicate read-back, the `attempt_required` refusal, the three '
  'independent budgets and the same-transaction suppression — is '
  'unchanged from 0043. Service-role-only.';
