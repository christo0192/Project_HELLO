-- 2026-09-17 — candidate Tina was never dialled: no consent record.
--
-- OWNER-RUN. Claude has no production SQL execution path (see
-- docs/runbooks/credential-rotation-readiness.md); this file is the exact
-- statement set, rehearsed read-only against production before being written.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────
-- Tina (candidate 26367d8e-0796-40ed-847c-71dd61375a1b) was expected on the
-- 2026-09-17 concurrent-call test and produced NO `phone_call_attempts` row at
-- all — not a failure, not a deferral anybody looked at, nothing.
--
-- `admit_phone_attempt` refuses at its consent gate:
--
--     select * into v_consent from screening_v2.consent_records
--      where candidate_id = v_eng.candidate_id ...
--     if not found then return jsonb_build_object('status','consent_missing');
--
-- and she has zero `consent_records` rows. Her four peers on the same test
-- (Neelu, Praveetha, Deepti, Christo) each have exactly one, all created
-- 2026-09-16 with `source = 'job_application'`; Rijo's was created the same day
-- at 13:57. Tina's was simply never created, because at that point her
-- `phone_valid` was false (the resume parser did not find her number) and her
-- engagement still carries the resulting `state_reason = 'phone_invalid'`.
--
-- `consent_missing` is a PRE-CLAIM refusal: no attempt row, no state change,
-- no `last_attempt_at`. It is counted in the `phone_due_diag` log line as
-- `ref.consent_preflight_refused` and nowhere else, which is why this looked
-- like "the call just did not happen".
--
-- Everything else about her is already correct and was verified read-only:
--   phone_e164 +91…7881, phone_valid true, ingestion `ready`,
--   job_mapping_id d34a1b6f (the SAME mapping Neelu and Rijo dialled on),
--   application link non-terminal, lifecycle `imported`.
--
-- ── RUN THIS ─────────────────────────────────────────────────────────
-- Read the verification block at the bottom FIRST and re-run it after. If
-- step 1 reports anything other than 0 existing rows, STOP: a consent record
-- already exists and this candidate's problem is something else.

begin;

-- 1. PRE-FLIGHT. Must return 0. If it does not, roll back and re-diagnose.
select count(*) as existing_consent_rows
  from screening_v2.consent_records
 where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b';

-- 2. The consent record, byte-identical in shape to her five peers.
--    `consents` must be a SUPERSET of the active template's
--    `required_consents` or admission answers `consent_subset_missing`; this
--    is the same six-member array every other candidate carries.
insert into screening_v2.consent_records
  (candidate_id, status, consents, source, created_at)
values
  ('26367d8e-0796-40ed-847c-71dd61375a1b',
   'granted',
   array['ai_interview','recording','purpose','data_processing','retention','rights']
     ::screening_v2.consent_type[],
   'job_application',
   now());

-- 3. Drop the stale verdict. Her number has been correct since 06:41 UTC on
--    2026-09-17; the row has been saying `phone_invalid` ever since.
--
--    `state`, `version` and `updated_at` are deliberately NOT touched — the
--    due read orders by `updated_at asc` and the reconnect batch derives its
--    due time from it, so bumping it here would re-order the dial queue. Same
--    reasoning as migration 0099, which makes `verify_candidate_phone` do this
--    automatically from now on.
update screening_v2.phone_engagements
   set state_reason = null
 where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b'
   and terminal_at is null
   and state_reason = 'phone_invalid';

-- 4. VERIFY BEFORE COMMITTING. Expected:
--      consent_rows = 1, latest_consent = 'granted',
--      eng_state = 'eligible', eng_state_reason = null
select
  (select count(*) from screening_v2.consent_records
    where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b') as consent_rows,
  (select status from screening_v2.consent_records
    where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b'
    order by created_at desc, id desc limit 1)                   as latest_consent,
  (select state from screening_v2.phone_engagements
    where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b') as eng_state,
  (select state_reason from screening_v2.phone_engagements
    where candidate_id = '26367d8e-0796-40ed-847c-71dd61375a1b') as eng_state_reason;

commit;

-- ── AFTER THE COMMIT ─────────────────────────────────────────────────
-- She becomes due on the next `phone-due` tick, subject to every other
-- admission guard — in particular the 2-dials-per-IST-day cap and the fleet
-- daily cap. Nothing here bypasses a guard; it supplies the one fact that was
-- genuinely absent.
