-- 0099_verify_phone_clears_stale_reason.sql
--
-- A CORRECTED NUMBER MUST NOT LEAVE THE OLD VERDICT ON THE ROW.
--
-- `phone_engagements.state_reason` is written by the dialer and cleared in
-- exactly one place: `admit_phone_attempt`, on the SUCCESS path, as part of the
-- transition to `dialing`. Nothing clears it on a refusal, and nothing clears
-- it when the CAUSE of the refusal is fixed. So an engagement that was refused
-- `phone_invalid` keeps saying `phone_invalid` until the day it is finally
-- dialled — which, if something else is also blocking it, is never.
--
-- That is not hypothetical. 2026-09-17, candidate Tina: the resume parser did
-- not find her number, her engagement recorded `state_reason = 'phone_invalid'`,
-- the number was corrected, and she still was not called. She has no
-- `consent_records` row, so `admit_phone_attempt` refuses her `consent_missing`
-- — a PRE-CLAIM refusal that writes no attempt row and changes no state. The
-- only thing on her engagement pointing at a cause was the stale
-- `phone_invalid`, and it was pointing at the wrong one. An operator reading
-- that row is sent to fix a number that is already correct.
--
-- ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ──────────────
-- `verify_candidate_phone` is the SANCTIONED route for correcting a number
-- (`candidates.ts` calls it from the HR-facing route; 0094 documents it as the
-- thing that rewrites `candidates.phone_e164`). It is therefore the one place
-- that KNOWS a `phone_invalid` verdict has just been superseded. It now clears
-- that one verdict, on that one candidate's non-terminal engagements.
--
-- Narrow on every axis, on purpose:
--
--   * ONLY `state_reason = 'phone_invalid'` is cleared. Any other reason is
--     about something this function did not fix and must survive.
--   * `state` is NOT touched. Eligibility is admission's decision and stays
--     admission's decision; this writes a label, never an edge.
--   * `updated_at` and `version` are NOT touched, and that is load-bearing
--     rather than tidy. The reconnect due-batch derives its due time from
--     `updated_at` (`phone-runtime/read.ts`), and the ordinary due read orders
--     by `updated_at asc` — so bumping it here would silently re-order the
--     dial queue and move reconnect backoffs as a side effect of an HR typo
--     correction. A same-state UPDATE that changes neither is a no-op to
--     `enforce_phone_engagement_transition`, which returns early on
--     `old.state = new.state`.
--   * `terminal_at is null` is required, because that same trigger raises
--     P0001 on ANY update to a terminal row. Without this predicate an HR
--     number correction would start failing outright for any candidate with a
--     finished engagement.
--   * The `= 'phone_invalid'` predicate is itself the idempotence guard:
--     re-verifying an already-clean candidate matches no row and writes
--     nothing, so `stale_phone_invalid_cleared` is 0 on the second call.
--
-- This does NOT retro-fix Tina: her number was corrected by direct SQL, not
-- through this function. Her recovery is the operator script at
-- `docs/runbooks/sql/2026-09-17-tina-consent-backfill.sql`. This migration
-- stops the next one happening.

-- ── The 0057 body verbatim, plus the stale-reason clear ───────────────
create or replace function screening_v2.verify_candidate_phone(
  p_candidate_id uuid,
  p_phone_e164 text,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_candidate screening_v2.candidates%rowtype;
  v_digest text;
  v_cleared integer := 0;
begin
  if p_phone_e164 is null or p_phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'invalid_phone');
  end if;
  select * into v_candidate from screening_v2.candidates
   where id = p_candidate_id for update;
  if not found then return jsonb_build_object('status', 'candidate_not_found'); end if;
  if p_actor_id is null then return jsonb_build_object('status', 'actor_required'); end if;

  v_digest := screening_v2.sha256_hex(p_phone_e164);
  update screening_v2.candidates
     set phone_e164 = p_phone_e164, phone_valid = true, updated_at = p_now
   where id = p_candidate_id;

  -- ── 0099: the verdict this call just superseded ────────────────────
  -- See the file header for why this touches neither `state`, `version` nor
  -- `updated_at`, and why `terminal_at is null` is mandatory rather than
  -- defensive.
  update screening_v2.phone_engagements
     set state_reason = null
   where candidate_id = p_candidate_id
     and terminal_at is null
     and state_reason = 'phone_invalid';
  get diagnostics v_cleared = row_count;

  insert into screening_v2.phone_number_verifications
    (candidate_id, phone_sha256, verified_by, verified_at, created_at)
  values (p_candidate_id, v_digest, p_actor_id, p_now, p_now);
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values (p_actor_id, 'recruiter', 'phone_number_reverified', 'candidate',
          p_candidate_id::text, 'success',
          -- Counts only. The number never reaches an audit row (0057).
          jsonb_build_object('verified', true,
                             'stale_phone_invalid_cleared', v_cleared));
  return jsonb_build_object('status', 'ok',
                            'stale_phone_invalid_cleared', v_cleared);
end;
$$;

revoke all on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.verify_candidate_phone(uuid, text, uuid, timestamptz)
  to service_role;
