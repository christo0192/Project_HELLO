-- R1 consent notices (PR-CT): the staff dry-run notice and the candidate notice, shipped as
-- immutable, versioned rows of the R1-only template table created by 0115.
--
-- DATA ONLY: one INSERT of two rows and one read-only verification block. No DDL, no function,
-- no grant. Phone and the legacy browser lane read the global consent tables; this file writes
-- only the R1 table, so their consent gate is byte-identical.
--
-- Immutability. 0115's trigger rejects every UPDATE and DELETE of a template row, so a wording
-- change can only ship as a NEW release, never as an edit of these rows or of this file.
--
-- Authority. r1_admit_attempt (0115, replaced by 0117) accepts a consent only when its template
-- is active AND its version equals the GREATEST active version of ANY locale (text ordering),
-- and when required_consents <@ consents. Two audiences therefore cannot be told apart by
-- version: each would supersede the other and one audience could never be admitted. Both rows
-- carry the SAME version and differ by locale instead, so both are authoritative together:
--   en-IN          the candidate notice
--   en-IN-x-staff  the staff dry-run notice (a BCP 47 private-use subtag)
-- The API must record the template the person was shown. A later release MUST insert BOTH
-- audience rows at a greater version, or the audience it omits can no longer be admitted.
-- Versions order as text: keep the numeric suffix to one digit per day (2026-10-06.10 sorts
-- BEFORE 2026-10-06.2) or zero-pad it.
--
-- AUDIENCE CONTRACT (a blocker for PR-3, PR-6 and PR-7, and for Stage A0). The audience is
-- picked by locale, but nothing in the database knows whether a round belongs to staff or to a
-- candidate: admission treats the two rows as equivalent (same version, same four keys). The
-- audience must therefore be owned by the server, never chosen by the client:
--   1. a server-owned field of the round, for example interview_rounds.consent_locale with
--      check (consent_locale in ('en-IN', 'en-IN-x-staff')), added by 0120 or 0124 and set only
--      by the Send R1 path as service_role;
--   2. PR-3 GET /consent-template and POST /consent load the template by THAT value and drop the
--      client locale (or answer 400 when it differs); PR-6 never picks or hard-codes a locale;
--   3. optionally, the migration that next replaces r1_admit_attempt adds
--      `and t.locale = v_round.consent_locale` to the consent EXISTS;
--   4. any client locale that stays must accept BCP 47 private use: PR-3's validator
--      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/ rejects 'en-IN-x-staff' (the private-use 'x'
--      subtag is one character), so every staff participant would see the candidate notice, and
--      once it is widened a candidate could send the staff locale and consent to text that says
--      no hiring decision is made about them.
--
-- RELEASE GATES. The notices promise behaviour that other PRs build, and a notice that is false
-- is worse than none. Each gate is repeated in the plan (R1-PLAN-final.md 7.8 and 10.4):
--   withdraw    the candidate withdraw control and POST /api/r1/consent/withdraw (PR-3, PR-6)
--               are live before ANY participant sees these notices: withdrawing stops a live
--               session with no upload and blocks scoring and status writes.
--   video       R1_VIDEO_RECORDING stays off until r1.sweep (90 days) and the R2 lifecycle rule
--               on prefix r1/ (PR-8) are deployed: the notice promises deletion at 90 days.
--   regions     the notice names Cloudflare R2 and LiveKit Cloud without a region (plan 7.8: per
--               Legal; the vendor region evidence is a Legal item, plan 10.5). The R2 bucket is
--               created only after Legal's jurisdiction advice (v2 section 12, step 7), so
--               nothing is stored where the notice is silent. A region Legal wants stated ships
--               as a new release of BOTH rows.
--   model       DeepSeek is named because the owner and Legal approved it (S0-B is NO-GO as
--               measured and the model may still change). If the interviewer or the scorer
--               moves to another provider, a new release re-ships BOTH rows before that provider
--               sees a participant.
--   retention   transcript and score retention rests on D-009, which Legal has not approved, so
--               the notice commits to no deletion date; a retention decision is a new release.
--   grievance   OPEN, needs the owner: a named grievance officer and a monitored address (plan
--               7.8). The notice routes complaints to the contact that sent the link, first;
--               naming the officer is a new release of BOTH rows. Decide before Stage B.
--
-- SIGN-OFF. The wording is the implementer's draft of the plan 7.8 itemisation, not Legal's
-- verbatim text. Legal and the owner sign off the exact two bodies; a sign-off is bound to the
-- md5 digests in the verification block at the end of this file, so any edit of a body voids it.
--
-- Consent keys (required_consents; the same four for both audiences, each shown as its own
-- agreement and all required, so declining any one routes the person to the alternative path):
--   ai_interview           the AI interviewer and the sales role-play
--   video_audio_recording  camera video and voice recorded for review by the hiring team
--   ai_evaluation          AI scoring that may update the application status
--   data_processing        the named providers, including DeepSeek in the PRC
-- ai_interview and data_processing reuse the phone vocabulary's names. video_audio_recording and
-- ai_evaluation are new: the phone 'recording' is audio-only. A phone-era consent therefore never
-- satisfies an R1 round (asserted in app/supabase/tests/r1_foundation_assert.sql). The label each
-- key carries at the point of consent lives in app/api/src/lib/r1/consent-items.ts.
--
-- Recording is stated although R1_VIDEO_RECORDING is off: the notice must already cover the
-- recording, the 90-day retention and the R2 store before the feature is switched on.
--
-- Body text is plain Markdown that stays readable when the markup characters are stripped: only
-- headings, one-line bullets and one-line paragraphs, ASCII only. The carriage returns of a
-- Windows checkout are removed so an immutable row can never carry them.
set local lock_timeout = '10s';

insert into screening_v2.interview_round_consent_templates
  (version, locale, title, body_md, required_consents, is_active)
values
  (
    '2026-10-06.1',
    'en-IN',
    'AI interview and role-play: notice and consent',
    replace($notice$# AI interview and role-play: notice and consent

You are invited to an AI interview for the Sales Program Advisor role at Interview Kickstart.

Please read this notice before you decide.

The interview starts only after you agree to every item under What you agree to.

## What the interview is
- An AI interviewer, not a person, speaks with you by voice for about 20 minutes.
- It starts with a short introduction and then announces a role-play.
- In the role-play the AI plays a prospective learner considering an Interview Kickstart course.
- You respond as a sales advisor would.
- The hiring team can review and change any result the AI produces.

## What we collect
- Your camera video and your voice.
- A written transcript of the conversation.
- Scores and notes produced by the AI evaluation.
- Technical details such as your device, browser and IP address.

## What you agree to
Each item is a separate agreement. Declining any item means the interview cannot go ahead.
- AI interview: you take part in an AI-led interview that includes a sales role-play.
- Video and audio recording: your camera video and voice may be recorded for the hiring team.
- AI evaluation: an AI system evaluates your interview and may update your application status.
- Data processing: the providers listed below process your data, including outside India.

## About the AI evaluation
- An AI system scores your interview and drafts a recommendation for the hiring team.
- It may automatically update your application status.
- The hiring team can review and change that status.
- You can contest it by contacting the hiring team.

## Who processes your data, and where
- Sarvam AI: converts speech to text and text to speech.
- DeepSeek: the language model behind the AI interviewer and the evaluation.
- DeepSeek processes and stores data in the People's Republic of China, where Chinese law applies.
- DeepSeek receives the text of your conversation. It does not receive your video or voice audio.
- LiveKit: relays live audio and video between your browser and our interview service.
- LiveKit runs on a server we operate at Fly.io (Singapore) or, as a fallback, on LiveKit Cloud.
- Cloudflare R2: stores the video recording, if one is made.
- Fly.io (Singapore): runs the interview service.
- Vercel: hosts the interview web page and passes your requests to our interview service.
- Supabase (Mumbai, India): stores your records.
- The Interview Kickstart hiring team can view your interview, transcript, scores and recording.

## How long we keep it
- Video recording: 90 days, then it is deleted.
- Transcript and scores: kept for as long as recruitment and legal purposes require.
- No fixed automatic deletion date applies to the transcript and scores at present.
- Providers may keep their own copies for a limited time under their own policies.

## Withdraw your consent
- You can withdraw at any time, before or during the interview.
- Use the withdraw option on your interview page, or contact the hiring team.
- If you withdraw during the interview, it stops straight away.
- We then delete any video recording of you.
- After you withdraw, we will not score the interview or change your application status from it.
- Withdrawing will not count against you.
- Withdrawal does not undo processing that already took place.

## If you prefer not to take part
- Taking part is your choice, and you can decline.
- If you decline, the hiring team will arrange a human interview with you instead.
- This also applies if you prefer not to use your camera or not to be evaluated by AI.

## Contact and your rights
- You can ask to access, correct or delete your data, and to contest an AI evaluation.
- Contact the Interview Kickstart hiring team that sent you this link.
- Reply to the message that contained the link.
- Send questions and complaints about your data to the same contact first.
- If you are not satisfied, you can complain to the Data Protection Board of India.

## Your agreement
By agreeing to an item you confirm that you have read this notice.$notice$, chr(13), ''),
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    true
  ),
  (
    '2026-10-06.1',
    'en-IN-x-staff',
    'AI interview dry run for staff: notice and consent',
    replace($notice$# AI interview dry run for staff: notice and consent

This is an internal dry run of Interview Kickstart's AI interview for Sales Program Advisors.

The project team runs it to test and tune the interview and its scoring.

It is not a real job application, and no hiring decision is made about you from it.

Please read this notice before you decide.

The dry run starts only after you agree to every item under What you agree to.

## What the dry run is
- An AI interviewer, not a person, speaks with you by voice for about 20 minutes.
- It starts with a short introduction and then announces a role-play.
- In the role-play the AI plays a prospective learner considering an Interview Kickstart course.
- You respond as a sales advisor would.
- Please do not share confidential company information or other people's personal data.

## What we collect
- Your camera video and your voice.
- A written transcript of the conversation.
- Scores and notes produced by the AI evaluation.
- Technical details such as your device, browser and IP address.

## What you agree to
Each item is a separate agreement. Declining any item means the dry run cannot go ahead.
- AI interview: you take part in an AI-led interview that includes a sales role-play.
- Video and audio recording: your camera video and voice may be recorded for the project team.
- AI evaluation: an AI system evaluates your dry run for the project team to review.
- Data processing: the providers listed below process your data, including outside India.

## About the AI evaluation
- An AI system scores your dry run and drafts a recommendation.
- The project team uses it to check and tune the scoring.
- It is not used to make any decision about you.

## Who processes your data, and where
- Sarvam AI: converts speech to text and text to speech.
- DeepSeek: the language model behind the AI interviewer and the evaluation.
- DeepSeek processes and stores data in the People's Republic of China, where Chinese law applies.
- DeepSeek receives the text of your conversation. It does not receive your video or voice audio.
- LiveKit: relays live audio and video between your browser and our interview service.
- LiveKit runs on a server we operate at Fly.io (Singapore) or, as a fallback, on LiveKit Cloud.
- Cloudflare R2: stores the video recording, if one is made.
- Fly.io (Singapore): runs the interview service.
- Vercel: hosts the interview web page and passes your requests to our interview service.
- Supabase (Mumbai, India): stores your records.
- The Interview Kickstart project team can view your dry run, transcript, scores and recording.

## How long we keep it
- Video recording: 90 days, then it is deleted.
- Transcript and scores: kept while the project team needs them to test and tune the interview.
- No fixed automatic deletion date applies to the transcript and scores at present.
- Providers may keep their own copies for a limited time under their own policies.

## Withdraw your consent
- You can withdraw at any time, before or during the dry run.
- Use the withdraw option on your interview page, or contact the project team.
- If you withdraw during the dry run, it stops straight away.
- We then delete any video recording of you.
- After you withdraw, we will not score the dry run or use it to test or tune the interview.
- Withdrawing will not count against you.
- Withdrawal does not undo processing that already took place.

## If you prefer not to take part
- Taking part is voluntary, and you can decline.
- If you decline, tell the project team and you will not be asked to take part.

## Contact and your rights
- You can ask to access, correct or delete your data.
- Contact the Interview Kickstart project team member who sent you this link.
- Reply to the message that contained the link.
- Send questions and complaints about your data to the same contact first.
- If you are not satisfied, you can complain to the Data Protection Board of India.

## Your agreement
By agreeing to an item you confirm that you have read this notice.$notice$, chr(13), ''),
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    true
  )
on conflict (version, locale) do nothing;

-- Verification (read-only). Supabase never re-runs an applied migration, so `on conflict do
-- nothing` only matters if production already holds drift, and then it would hide it:
--   - a row at the same (version, locale) with other text would silently win;
--   - an active row at a greater version (a smoke row such as 'test', or '9002') would leave
--     both new rows non-authoritative, every admission would answer consent_missing, and
--     immutability means only a still greater release could repair it.
-- Either condition fails the migration here, loudly, instead of in production use. The digests
-- are md5(body_md) of the two bodies above and are what a sign-off is bound to.
do $verify$
declare
  v_release constant text := '2026-10-06.1';
  v_keys constant jsonb :=
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb;
  v_candidate_md5 constant text := '1a24de21b495d24c61484720c2c0dbec';
  v_staff_md5 constant text := 'cbb69bcbfd332457d54edfe26c2c8016';
  v_rows integer;
  v_active integer;
  v_newest text;
begin
  select count(*), count(*) filter (where is_active)
    into v_rows, v_active
    from screening_v2.interview_round_consent_templates
   where version = v_release;
  if v_rows <> 2 or v_active <> 2 then
    raise exception '0123: expected exactly 2 active rows at version %, found % rows, % active',
      v_release, v_rows, v_active;
  end if;
  if not exists (
    select 1
      from screening_v2.interview_round_consent_templates
     where version = v_release and locale = 'en-IN' and is_active
       and required_consents = v_keys and md5(body_md) = v_candidate_md5
  ) then
    raise exception '0123: the en-IN row at version % is not the shipped candidate notice',
      v_release;
  end if;
  if not exists (
    select 1
      from screening_v2.interview_round_consent_templates
     where version = v_release and locale = 'en-IN-x-staff' and is_active
       and required_consents = v_keys and md5(body_md) = v_staff_md5
  ) then
    raise exception '0123: the en-IN-x-staff row at version % is not the shipped staff notice',
      v_release;
  end if;
  select max(version) into v_newest
    from screening_v2.interview_round_consent_templates
   where is_active;
  if v_newest is distinct from v_release then
    raise exception '0123: version % is not the greatest active template version (found %)',
      v_release, v_newest;
  end if;
end;
$verify$;
