-- ═══════════════════════════════════════════════════════════════════════
-- 0103 — the screen is written about THIS candidate
-- ═══════════════════════════════════════════════════════════════════════
--
-- `0044` gave every candidate for a role the same questions. That is right
-- for the fixed compartments — the introduction, the night-shift question and
-- the three pay questions are asked of everyone because the answers are only
-- comparable if the question was the same. It is wrong for the two
-- compartments that exist to find out whether THIS person can do THIS job:
-- "walk me through a time you handled an unhappy customer" is a fine question
-- for a résumé that mentions support, and a wasted slot for one that does not.
--
-- So `profile_relevance` and `stability` are now written per candidate, from
-- their résumé, before the call. Everything else about the screen is
-- unchanged, deliberately.
--
-- WHAT THIS MIGRATION DOES, in order of how much it could hurt:
--
--   1. `phone_normalize_question_plan` — a NEW function that is a faithful
--      extraction of the validation loop `0044` ran inline. Same rules, same
--      bounds, same output shape. It returns NULL where the loop set
--      `v_invalid`. Nothing about the role-template path changes; the loop
--      simply has a name now, so two callers can share it.
--
--   2. `candidate_screening_questions` — a new table holding one generated
--      set per ENGAGEMENT.
--
--   3. `start_phone_assessment` — REPLACED, and the replacement is the 0044
--      body with exactly one block changed: the plan now prefers a ready
--      candidate set and falls back to the role template. Every lock, every
--      binding check, every refusal and the idempotent snapshot are identical
--      to 0044, which is a claim the PR demonstrates as a diff rather than
--      asserting here.
--
-- KEYED ON THE ENGAGEMENT, not the candidate. An engagement is one screening
-- cycle. A rescreen (`0057`) opens a new one and therefore asks for a fresh
-- set rather than re-using questions written about a conversation that has
-- already happened, and the `on delete cascade` means a purged engagement
-- takes its generated questions with it — including through DSAR erasure,
-- which is why this table holds no candidate identifiers of its own.
--
-- THE FALLBACK IS ASYMMETRIC, ON PURPOSE. `0044` REFUSES to start a call on a
-- malformed role template rather than substituting the defaults, because
-- screening someone against questions nobody chose while the recruiter
-- believes their own template is running is worse than not screening them.
-- That argument does not transfer: a candidate set is a machine-written
-- enhancement OF the recruiter's template, so when one is missing, unfinished
-- or malformed the honest thing is the template itself — the screen the
-- candidate would have had yesterday. A generator bug must never be able to
-- end a live call.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. phone_normalize_question_plan — 0044's loop, extracted
-- ═══════════════════════════════════════════════════════════════════════
-- Returns the worker-shaped question array, or NULL if the input is not a
-- usable template. NULL is the ONLY failure signal: each caller decides for
-- itself whether that means "refuse" or "fall back", and the two callers
-- decide differently.
--
-- The rules are `0044`'s, unchanged and in the same order:
--   * a JSON array of at most 100 objects
--   * each item an object carrying a non-blank `id` and `question`
--   * `id` matching ^[A-Za-z0-9_.:-]{1,100}$ and unique within the array
--   * `question` and `follow_up_hint` at most 2000 characters
--   * `mandatory`, when present, a JSON boolean
--
-- An EMPTY array returns an empty array rather than NULL, because "empty" and
-- "malformed" are different states and the caller distinguishes them before
-- it gets here — 0044 sent an empty template to the default plan, and still
-- does.
--
-- Unknown keys are IGNORED rather than refused, exactly as the inline loop
-- ignored them: `category`, added when the call was split into named
-- compartments, reaches this function on every modern template and must not
-- invalidate it. Only the four keys below are ever copied into the plan, so
-- nothing a template carries can reach the worker except through this
-- projection.
create or replace function screening_v2.phone_normalize_question_plan(
  p_template jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, screening_v2
as $$
declare
  v_item      jsonb;
  v_key       text;
  v_text      text;
  v_hint      text;
  v_keys      text[] := array[]::text[];
  v_questions jsonb  := '[]'::jsonb;
begin
  if p_template is null
     or jsonb_typeof(p_template) <> 'array'
     or jsonb_array_length(p_template) > 100 then
    return null;
  end if;

  for v_item in select value from jsonb_array_elements(p_template) loop
    if jsonb_typeof(v_item) <> 'object' then
      return null;
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
      return null;
    end if;
    v_keys := v_keys || v_key;
    v_questions := v_questions || jsonb_build_array(jsonb_build_object(
      'key', v_key,
      'text', v_text,
      'mandatory', coalesce(v_item -> 'mandatory' = 'true'::jsonb, false),
      'hint', v_hint));
  end loop;

  return v_questions;
end;
$$;

-- EXPOSURE, like every other pure `phone_*` helper in this schema. It is not
-- SECURITY DEFINER because it touches no table and needs no privilege — it is
-- a function of its argument. What it must not be is reachable from a browser
-- session, so the default PUBLIC execute grant is revoked and only the role
-- that calls it keeps one. `0042`'s posture test enforces both halves.
revoke all on function screening_v2.phone_normalize_question_plan(jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_normalize_question_plan(jsonb)
  to service_role;

comment on function screening_v2.phone_normalize_question_plan is
  'Validates a screening template and projects it into the worker''s '
  '{key,text,mandatory,hint} plan shape, or returns NULL if it is not a '
  'usable template. Extracted from 0044''s inline loop so that the role '
  'template and a per-candidate set are judged by exactly the same rules.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. candidate_screening_questions — one generated set per engagement
-- ═══════════════════════════════════════════════════════════════════════
-- `status` is the whole state machine, and it is deliberately tiny:
--
--   pending  a job has been enqueued; nothing generated yet
--   ready    a validated set is in `questions` and the next call will use it
--   failed   generation gave up; `error_reason` says why, and the call runs
--            the role template exactly as it does today
--
-- There is no `running`: the durable queue owns the lease, the retry budget
-- and the crash recovery, and duplicating any of that here would give two
-- places to disagree about whether work is in flight.
create table if not exists screening_v2.candidate_screening_questions (
  engagement_id uuid primary key
                  references screening_v2.phone_engagements(id) on delete cascade,
  role_id       uuid references screening_v2.roles(id) on delete set null,
  status        text not null default 'pending',
  -- The FULL ordered template this call should run: the role's fixed
  -- compartments verbatim, with the résumé-driven questions spliced into the
  -- two compartments allowed to vary. Stored whole rather than as a patch,
  -- because the array IS the conversation and applying a patch at call time
  -- would put assembly on the live path.
  questions     jsonb,
  -- What the role template looked like when this set was built. A recruiter
  -- who edits the template afterwards invalidates the set: it was assembled
  -- around questions that are no longer the ones they chose.
  template_hash text,
  model         text,
  error_reason  text,
  created_at    timestamptz not null default now(),
  generated_at  timestamptz,
  constraint chk_candidate_questions_status check (
    status in ('pending','ready','failed')),
  -- READY MEANS USABLE. Without this a generator bug could mark a row ready
  -- with a null or empty array. The plan builder would then fall back, which
  -- is safe — but silently, while the row claimed a success that never
  -- happened and no operator had any reason to look.
  constraint chk_candidate_questions_ready check (
    status <> 'ready'
    or (questions is not null
        and jsonb_typeof(questions) = 'array'
        and jsonb_array_length(questions) between 1 and 100))
);

-- The generator sweeps for abandoned work by status; the plan builder reads
-- by primary key and needs no index of its own.
create index if not exists idx_candidate_questions_pending
  on screening_v2.candidate_screening_questions (created_at)
  where status = 'pending';

comment on table screening_v2.candidate_screening_questions is
  'One per-engagement screening template, generated from the candidate''s '
  'résumé. Read by start_phone_assessment in preference to the role '
  'template; an absent, unfinished or malformed row simply means the call '
  'runs the role template, which is what every call did before 0103.';

-- RLS ON WITH ZERO POLICIES, which is this schema's posture for every table
-- nothing browser-side may read: `service_role` bypasses row-level security,
-- and anything else gets an empty result rather than an error. The grants below
-- are the second half of the same control — a table with RLS on but a lingering
-- `authenticated` grant is one policy away from being readable.
alter table screening_v2.candidate_screening_questions enable row level security;
revoke all on screening_v2.candidate_screening_questions from public, anon, authenticated;
grant select, insert, update, delete
  on screening_v2.candidate_screening_questions to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. phone_session_plans.source gains a third value
-- ═══════════════════════════════════════════════════════════════════════
-- Nothing branches on `source` — it is observability, and the only reason it
-- is constrained at all is so a typo cannot make a plan's provenance a lie.
-- Which is exactly why the new value has to be declared here: without it the
-- snapshot insert would fail the CHECK and every candidate-driven call would
-- die at the moment its plan was written.
alter table screening_v2.phone_session_plans
  drop constraint if exists chk_phone_session_plans_source;
alter table screening_v2.phone_session_plans
  add constraint chk_phone_session_plans_source check (
    source in ('role_template','default','candidate_resume'));

-- ═══════════════════════════════════════════════════════════════════════
-- 4. start_phone_assessment — 0044's body, one block changed
-- ═══════════════════════════════════════════════════════════════════════
-- Reproduced in full because PL/pgSQL has no way to patch a function. The
-- ONLY differences from 0044 are:
--   * one new local, `v_candidate`
--   * the five locals the extracted loop used are gone
--   * the plan-selection block reads the candidate set first and falls back
-- Everything else — the lock order, the binding verification against the
-- deterministic room name, the consent gate, `already_scored`,
-- `session_already_bound`, the read-back through
-- `get_phone_assessment_state` — is unchanged.
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
  -- The per-candidate set, when one has been generated for THIS
  -- engagement. Read before the role template and used in its place.
  v_candidate jsonb;
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
    -- ── ALREADY SCORED IS A DIFFERENT ANSWER FROM NOT ACTIVE ────────
    -- A session that is `completed` AND already carries a phone-sourced
    -- assessment is a SCORED screening whose acknowledgement was lost —
    -- the completion endpoint succeeded, inserted the row, and its
    -- response never reached the worker. The leg that saw that halted
    -- and posted nothing, which was right; a LATER leg then arrives
    -- here, and answering `session_not_active` tells it only that it
    -- cannot screen. It does not tell it the screening is finished.
    --
    -- Collapsing the two leaves the engagement with no way to reach
    -- `completed` from any leg: it rests non-terminal until a budget or
    -- a sweeper ends it, or goes `failed` if something posts an abort —
    -- a truthful terminal for an untruthful reason, over a screening
    -- that exists and is scored.
    --
    -- The binding checks above have ALREADY run, so `already_scored` can
    -- only ever describe a session that named this exact phone room and
    -- belongs to this engagement's candidate. A worker cannot fish for
    -- somebody else's completion with it.
    --
    -- It carries NO plan and NO cursor, deliberately: there is nothing
    -- left to screen. The only legitimate action on it is to post
    -- `assessment.completed`, which 0044's own interlock will accept
    -- precisely because the row this branch just found is there.
    if v_sess.status = 'completed'
       and exists (
         select 1 from screening_v2.assessments a
          where a.session_id = p_session_id
            and a.source = 'phone') then
      return jsonb_build_object('status', 'already_scored',
                                'session_status', v_sess.status,
                                'assessment_exists', true);
    end if;
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

    -- ── THE CANDIDATE'S OWN QUESTIONS COME FIRST ────────────────────
    -- Generated from this candidate's resume, against this role, and
    -- keyed on the ENGAGEMENT — one screening cycle. A rescreen opens a
    -- new engagement and therefore asks for a fresh set rather than
    -- re-using questions written about an older conversation.
    --
    -- This read is the only new work on the call-start path: one index
    -- lookup on a primary key the engagement row already names.
    select questions into v_candidate
      from screening_v2.candidate_screening_questions
     where engagement_id = v_eng.id and status = 'ready';

    v_questions := screening_v2.phone_normalize_question_plan(v_candidate);
    if v_questions is not null then
      v_source := 'candidate_resume';
    else
      -- ── AND FALL BACK TO THE ROLE TEMPLATE, DELIBERATELY ──────────
      -- An absent, unfinished or malformed candidate set is NOT refused
      -- the way a malformed role template is, and the asymmetry is the
      -- point: the role template is what a recruiter chose, so screening
      -- against anything else would be a lie. The candidate set is a
      -- machine-written ENHANCEMENT of it. Refusing on a generator bug
      -- would end live calls for a feature whose whole promise is that it
      -- can only make the screen sharper; falling back gives the
      -- candidate exactly the screen they would have had yesterday.
      if v_role_id is not null then
        select screening_template into v_template
          from screening_v2.roles where id = v_role_id;
      end if;

      if v_template is null
         or jsonb_typeof(v_template) <> 'array'
         or jsonb_array_length(v_template) = 0 then
        v_questions := screening_v2.phone_default_question_plan();
        v_source    := 'default';
      else
        v_questions := screening_v2.phone_normalize_question_plan(v_template);
        if v_questions is null then
          v_invalid := true;
        else
          v_source := 'role_template';
        end if;
      end if;
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
