-- ═══════════════════════════════════════════════════════════════════════
-- 0105 — the gate transcript is written AS IT HAPPENS, and kept regardless
--        of how the call ends
-- ═══════════════════════════════════════════════════════════════════════
--
-- FORWARD-ONLY. It re-declares exactly one function (`commit_phone_item_turn`,
-- last declared in 0071) with one additional defaulted parameter, and changes
-- nothing else. No table, column, index or constraint is touched.
--
-- ── WHY ────────────────────────────────────────────────────────────────
-- On 2026-09-25 five real candidates were dialled. Every call ended inside
-- the consent gate — two hung up within thirty seconds, one was classed as a
-- machine, two sat on a frozen worker for six minutes. Afterwards there was
-- NOTHING to read: zero transcript rows and zero audio for any of the five,
-- because both were gated on consent by design. The pre-consent transcript
-- had exactly one writer, `commit_phone_gate_turns` (0067), and it runs ONCE,
-- at the moment consent is applied. A call that dies before that moment has
-- never had a single word of it persisted.
--
-- The owner's decision, with legal sign-off (2026-09-26): the transcript and
-- the recording persist from the start of the call, whether or not consent is
-- reached. This migration is the transcript half. The recording half needs no
-- SQL — `attach_phone_attempt_recording` has accepted a `dialing` engagement
-- since 0067, and the worker simply starts capture at `call.answered` now.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────
-- `commit_phone_item_turn` (0071) already writes one turn the moment it lands
-- and already accepts a `waiting` session — the gate's session state. It only
-- ever wrote `is_gate = false`, because it was armed for the SCORED phase
-- alone. It now takes `p_is_gate boolean default false`, so the worker can
-- persist the disclosure, the identity turn and the consent reply as they are
-- spoken, flagged `is_gate = true` exactly as 0067's once-writer flagged them.
-- Every downstream reader keeps its meaning:
--
--   * 0070's resume projection EXCLUDES `is_gate = true`, so no gate chatter
--     reaches a resuming leg's model (the 2026-08-29 cross-leg leak stays
--     closed);
--   * the scorer and the dashboard word count exclude them the same way;
--   * the recruiter transcript view reads every row and TAGS gate turns, so
--     the consent exchange is finally visible on a call that died there.
--
-- ── THE CONSENT-SKIP INVARIANT, STATED SO NOBODY RE-DERIVES IT WRONG ──
-- 0070 exposes `gate_recorded := exists(is_gate = true rows)`, and the worker
-- uses it to SKIP asking consent again on a re-dispatched leg. Writing gate
-- rows BEFORE consent would look like it could turn that into a consent
-- bypass. It cannot: `get_phone_assessment_state` returns `plan_missing` —
-- before it ever derives `gate_recorded` — when the session has no plan, and
-- the plan is snapshotted by `start_phone_assessment` behind `in_call`, which
-- is reachable only through `disclosure.delivered`. The worker consults
-- `gate_recorded` only on an `ok` state. So: rows without consent ⇒ no plan
-- ⇒ `plan_missing` ⇒ the gate runs in full. The real-Postgres harness
-- (`scripts/test-gate-transcript.sh`) asserts this by execution.
--
-- ── `commit_phone_gate_turns` IS NOW NORMALLY A NO-OP ──────────────────
-- Its guard is "any `is_gate = true` row exists", so on a worker that writes
-- per-item gate rows it answers `already_recorded` — which the route and the
-- client already treat as success. The worker stops calling it when per-item
-- gate persistence is on, so the two writers never race to duplicate a line.
-- The RPC stays for in-flight legs on the previous worker image.
--
-- ── SIGNATURE CHANGE, DONE THE 0083 WAY ────────────────────────────────
-- A defaulted parameter is a NEW overload to Postgres, and PostgREST cannot
-- choose between two candidates that both accept the same named arguments.
-- So the 0071 signature is dropped first, exactly as 0083 did for
-- `abandon_phone_attempt_infra`. Callers pass named arguments only.

drop function if exists screening_v2.commit_phone_item_turn(
  uuid, text, text, text, bigint, timestamptz);

create or replace function screening_v2.commit_phone_item_turn(
  p_session_id         uuid,
  p_speaker            text,
  p_text               text,
  p_source_item_id     text,
  p_turn_started_at_ms bigint      default null,
  p_is_gate            boolean     default false,
  p_now                timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess    screening_v2.call_sessions%rowtype;
  v_text    text;
  v_base    integer;
  v_id      uuid;
  v_anchor  bigint;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- ── SHAPE FIRST, answered truthfully ───────────────────────────────
  -- A malformed body is told exactly why and nothing is written. The
  -- source_item_id shape mirrors the boundary's source_event_id regex so a
  -- worker cannot smuggle an unbounded key into a durable column.
  if p_source_item_id is null
     or p_source_item_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_speaker is null
     or p_speaker not in ('bot', 'candidate') then
    return jsonb_build_object('status', 'invalid_turn');
  end if;
  v_text := btrim(coalesce(p_text, ''));
  if v_text = '' or length(v_text) > 8000 then
    return jsonb_build_object('status', 'invalid_turn');
  end if;
  -- The 0026 timing window: coerce anything outside it to NULL rather than
  -- fail — timing is best-effort, the transcript write must not fail on it.
  if p_turn_started_at_ms is not null
     and (p_turn_started_at_ms <= 0 or p_turn_started_at_ms >= 4102444800000) then
    v_anchor := null;
  else
    v_anchor := p_turn_started_at_ms;
  end if;

  -- The SESSION row lock, and nothing above it — a strict prefix of the
  -- assessment RPCs' lock order, so this never deadlocks against them and
  -- serialises the max(turn_index) read with every concurrent writer.
  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;
  -- Live during the gate (`waiting`) and the assessment (`in_progress`). A
  -- terminal session's transcript is closed; refuse rather than append.
  if v_sess.status not in ('waiting', 'in_progress') then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  -- ── IDEMPOTENT ON THE ITEM ─────────────────────────────────────────
  -- A duplicate delivery of the SAME item converges on the ORIGINAL row.
  -- Read the existing row back so the caller is told `applied` with the
  -- original turn_index rather than a false failure.
  select id into v_id from screening_v2.transcript_turns
   where session_id = p_session_id and source_item_id = p_source_item_id;
  if found then
    return jsonb_build_object('status', 'applied', 'applied', true,
                              'duplicate', true);
  end if;

  -- ── Append at the session's next index, guarded ON CONFLICT ────────
  -- The `on conflict do nothing` is belt-and-suspenders behind the read
  -- above: two racing deliveries of the same item that both passed the read
  -- under the same lock cannot both insert, and a concurrent per-item write
  -- for a DIFFERENT item takes the next index because the lock serialises the
  -- max read. `is_gate` is the caller's flag: TRUE for the disclosure,
  -- identity and consent exchange written as it happens (0105), FALSE for a
  -- scored assessment turn (0071). A NULL is read as FALSE, never as gate.
  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, is_gate, created_at,
     turn_started_at_ms, source_item_id)
  values
    (p_session_id, v_base, p_speaker, v_text, coalesce(p_is_gate, false), p_now,
     v_anchor, p_source_item_id)
  on conflict (session_id, source_item_id) where source_item_id is not null
    do nothing;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'duplicate', false, 'turn_index', v_base);
end;
$$;

revoke all on function screening_v2.commit_phone_item_turn(
  uuid, text, text, text, bigint, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_item_turn(
  uuid, text, text, text, bigint, boolean, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_item_turn(
  uuid, text, text, text, bigint, boolean, timestamptz) is
  'Persists ONE phone transcript turn as it happens, deduped on '
  'source_item_id. p_is_gate flags the pre-consent disclosure/identity/'
  'consent exchange (0105) so it is kept even when the call dies at the '
  'gate, yet stays excluded from the resume context and the scorer. '
  'Service-role-only.';
