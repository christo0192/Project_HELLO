# Phone latency experiment

This runbook is for an owner-gated phone test only. It does not authorize a carrier call and does not clear `operator_pause`.

## Defaults and rollback

The default path remains:

- `PHONE_TURN_DETECTION=local`
- `PHONE_DYNAMIC_ENDPOINTING=false`
- `PHONE_OBJECTIVE_PREEMPTIVE=off`
- `PHONE_SARVAM_HIGH_VAD_SENSITIVITY=false`
- `PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC` unset (0.5 seconds)
- maximum local endpointing delay 1.5 seconds

Unset the experiment variables to restore the default path.

## Safe A/B sequence

1. Run the default phone path and collect the sanitized worker log.
2. Enable only `PHONE_SARVAM_HIGH_VAD_SENSITIVITY=true` for the owner-gated test.
3. Compare the same phone latency spans and inspect for truncation, split finals, interruptions, and false end-of-speech decisions.
4. Only if the Sarvam experiment improves finalization without regressions, test one documented negative-VAD parameter at a time.
5. Only after that comparison, test `PHONE_STATIC_ENDPOINTING_MIN_DELAY_SEC=0.3` as a separate phone-only experiment.
6. Keep dynamic endpointing and preemptive generation disabled unless separately approved.

## Required evidence

The worker emits no transcript text in diagnostic fields. Compare:

- `voice_phone_boundary:local_vad_end`
- `voice_phone_boundary:stt_final_arrived`
- `local_vad_end_to_final_transcript`
- `speech_end_to_final_transcript`
- `final_transcript_to_turn_callback`
- `turn_callback_to_reply_created`
- `reply_created_to_first_tts_frame`
- `reply_created_to_first_audio`
- `local_vad_end_to_first_audio`
- `generation_completed_empty` with sanitized `rejection_reason`

A successful experiment must preserve zero `no_first_audio`, no stale audio, no repeated objectives, and immediate same-source resume-conflict clarification.
