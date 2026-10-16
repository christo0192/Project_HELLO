-- R1 consent notices, release 2026-10-16.1: the 20-minute role-play makes the interview about 30
-- minutes long, so both notices of release 2026-10-06.1 (0123) said the wrong length ("speaks with
-- you by voice for about 20 minutes"). This release is those two bodies VERBATIM except that one
-- sentence, which now reads "for about 30 minutes". Titles and required consents are unchanged.
--
-- DATA ONLY, like 0123: one INSERT of two rows and one read-only verification block.
--
-- Rules carried over from 0123 (read its header):
--   * the rows are immutable (0115's trigger), so a wording change is a NEW release, never an edit;
--   * r1_admit_attempt accepts a consent only to the GREATEST active version, so BOTH audience rows
--     (en-IN, en-IN-x-staff) ship together at the same, greater version. 2026-10-16.1 sorts after
--     2026-10-06.1 as text. The 0123 rows stay (immutable) but stop being authoritative: a person
--     who consented to 2026-10-06.1 and has not started yet is asked to consent again
--     (consent_missing -> 409 consent_required, and the page shows the current notice);
--   * SIGN-OFF: Legal and the owner sign off the exact two bodies, bound to the md5 digests in the
--     verification block below. These are new digests: the 0123 sign-off does not carry over, so
--     this release needs its own sign-off before it is deployed.
set local lock_timeout = '10s';

insert into screening_v2.interview_round_consent_templates
  (version, locale, title, body_md, required_consents, is_active)
values
  (
    '2026-10-16.1',
    'en-IN',
    'AI interview and role-play: notice and consent',
    replace($notice$# AI interview and role-play: notice and consent

You are invited to an AI interview for the Sales Program Advisor role at Interview Kickstart.

Please read this notice before you decide.

The interview starts only after you agree to every item under What you agree to.

## What the interview is
- An AI interviewer, not a person, speaks with you by voice for about 30 minutes.
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
    '2026-10-16.1',
    'en-IN-x-staff',
    'AI interview dry run for staff: notice and consent',
    replace($notice$# AI interview dry run for staff: notice and consent

This is an internal dry run of Interview Kickstart's AI interview for Sales Program Advisors.

The project team runs it to test and tune the interview and its scoring.

It is not a real job application, and no hiring decision is made about you from it.

Please read this notice before you decide.

The dry run starts only after you agree to every item under What you agree to.

## What the dry run is
- An AI interviewer, not a person, speaks with you by voice for about 30 minutes.
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

-- Verification (read-only), as in 0123: exactly the two shipped rows at this release, the signed
-- bodies (md5), the four keys, and this release is the greatest active version.
do $verify$
declare
  v_release constant text := '2026-10-16.1';
  v_keys constant jsonb := '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb;
  v_candidate_md5 constant text := '6f950eeda8dc15b59f76be0179bf3227';
  v_staff_md5 constant text := 'defbb70680828d785179758cfd34606a';
  v_rows integer;
  v_active integer;
  v_newest text;
begin
  select count(*), count(*) filter (where is_active)
    into v_rows, v_active
    from screening_v2.interview_round_consent_templates
   where version = v_release;
  if v_rows <> 2 or v_active <> 2 then
    raise exception '0129: expected exactly 2 active rows at version %, found % rows, % active',
      v_release, v_rows, v_active;
  end if;
  if not exists (
    select 1
      from screening_v2.interview_round_consent_templates
     where version = v_release and locale = 'en-IN' and is_active
       and required_consents = v_keys and md5(body_md) = v_candidate_md5
  ) then
    raise exception '0129: the en-IN row at version % is not the shipped candidate notice',
      v_release;
  end if;
  if not exists (
    select 1
      from screening_v2.interview_round_consent_templates
     where version = v_release and locale = 'en-IN-x-staff' and is_active
       and required_consents = v_keys and md5(body_md) = v_staff_md5
  ) then
    raise exception '0129: the en-IN-x-staff row at version % is not the shipped staff notice',
      v_release;
  end if;
  select max(version) into v_newest
    from screening_v2.interview_round_consent_templates
   where is_active;
  if v_newest is distinct from v_release then
    raise exception '0129: version % is not the greatest active template version (found %)',
      v_release, v_newest;
  end if;
end;
$verify$;
