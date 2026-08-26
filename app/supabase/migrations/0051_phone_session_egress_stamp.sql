-- 0051_phone_session_egress_stamp.sql
--
-- ── WHY THIS EXISTS (first recorded live call, 2026-08-26) ──────────────
-- The phone lane's recording egress binds its keys to the ATTEMPT row (0043/
-- 0050) — and nothing ever told the SESSION row. Every consumer of a
-- recording is session-keyed: the recruiter download route serves
-- `call_sessions.recording_object_key` behind its REC-04/05/06 gates, the
-- 0038 finalize trigger fires on a terminal session WITH `recording_egress_id`
-- set, and the finalize worker/sweeper converge sessions, not attempts. So
-- the first live phone MP3 landed in the bucket, 2.1 MB, verified — and the
-- dashboard said "Recording not found", truthfully, because the one row the
-- read path consults had never heard of it.
--
-- The fix is a STAMP at recording start: the moment the phone egress is
-- created, the session row acquires `recording_egress_id` and
-- `recording_egress_status = 'active'` — exactly what the browser path leaves
-- behind — and the ENTIRE existing convergence stack (0038 trigger on every
-- terminal status, the sweeper, and the download route's on-demand
-- finalization for completed sessions) then serves phone recordings with no
-- further phone-specific machinery. Object key, sha256 and size are
-- deliberately NOT stamped here: `finalize_authoritative_recording` (0025/
-- 0038) is the only writer of integrity columns, and pre-stamping a key the
-- finalizer has not verified would let the download route serve an object
-- whose integrity was never checked.
--
-- ── GUARDS ──────────────────────────────────────────────────────────────
-- * The egress id must be shaped like one (same pattern 0050 accepts).
-- * The attempt must exist and its engagement's CANDIDATE must be the
--   session's candidate — the same association `verifySessionHint` proves
--   before the egress is started (the session was provisioned for this
--   candidate by `ensureSession` at dial time). A session belonging to
--   anyone else can never acquire this attempt's egress.
-- * An attempt already bound to a DIFFERENT session refuses: the binding CAS
--   at /assessment/start owns the authoritative pairing and this stamp must
--   never contradict it.
-- * A session whose recording is legally or operationally finished
--   (deleted / revoked / quarantined) is immutable to this stamp.
-- * Idempotent on the same egress id; a DIFFERENT egress id refuses rather
--   than overwrites — two egresses claiming one session is an incident to
--   surface, not a race to lose silently.

create or replace function screening_v2.stamp_phone_session_egress(
  p_session_id uuid,
  p_attempt_id uuid,
  p_egress_id  text,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_ses screening_v2.call_sessions%rowtype;
begin
  if p_session_id is null or p_attempt_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_egress_id is null or p_egress_id !~ '^EG_[A-Za-z0-9_-]{4,200}$' then
    return jsonb_build_object('status', 'invalid_egress_id');
  end if;

  select a.* into v_att
    from screening_v2.phone_call_attempts a
   where a.id = p_attempt_id
     for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select e.* into v_eng
    from screening_v2.phone_engagements e
   where e.id = v_att.engagement_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select s.* into v_ses
    from screening_v2.call_sessions s
   where s.id = p_session_id
     for update;
  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  if v_ses.candidate_id is distinct from v_eng.candidate_id then
    return jsonb_build_object('status', 'session_candidate_mismatch');
  end if;

  if v_att.session_id is not null and v_att.session_id <> p_session_id then
    return jsonb_build_object('status', 'session_already_bound');
  end if;

  if v_ses.recording_deleted_at is not null
     or v_ses.recording_revoked_at is not null
     or coalesce(v_ses.recording_quarantined, false) then
    return jsonb_build_object('status', 'recording_terminal');
  end if;

  if v_ses.recording_egress_id is not null then
    if v_ses.recording_egress_id = p_egress_id then
      return jsonb_build_object('status', 'ok', 'duplicate', true);
    end if;
    return jsonb_build_object('status', 'egress_already_bound');
  end if;

  update screening_v2.call_sessions
     set recording_egress_id     = p_egress_id,
         recording_egress_status = 'active'
   where id = p_session_id;

  return jsonb_build_object('status', 'ok', 'duplicate', false);
end;
$$;

revoke all on function screening_v2.stamp_phone_session_egress(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.stamp_phone_session_egress(uuid, uuid, text, timestamptz)
  to service_role;

comment on function screening_v2.stamp_phone_session_egress is
  'Stamps SESSION-level egress bookkeeping (recording_egress_id + active '
  'status) the moment a phone attempt''s recording egress starts, so the '
  'existing 0038 finalize convergence and the recruiter download route can '
  'see phone recordings at all. Integrity columns stay the finalizer''s '
  'alone. Candidate-association guarded, idempotent per egress id, refuses '
  'a second egress rather than overwriting.';
