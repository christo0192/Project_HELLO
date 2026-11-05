-- 0136 — R1 turn timing facts on transcript_turns: which AI voice spoke, when a turn ended, and how
-- long an AI line played.
--
-- WHY. A turn has only had a start (0026). Without an end, a reviewer's speaker timeline cannot draw
-- talk segments (start-to-next-start would show silence as talk), and without the voice the review
-- can only guess Christy or the learner from the phase, which is wrong for a learner reply planned
-- in an aside. The R1 worker knows all three as each line plays. M026 R1-REVIEW-PLAN.md, PR 4.
--
-- WHAT. Three nullable columns, no default:
--   * turn_ended_at_ms  epoch ms on the worker's clock, the same clock as turn_started_at_ms. AI row:
--                       when its audio stopped, which on a line the candidate's voice paused and that
--                       was then cut is the pause, not the cut reported seconds later. Candidate row:
--                       the voice-activity end of speech.
--   * ai_voice          the worker's voice role, 'interviewer' (Christy) or 'learner'. Bot rows only.
--   * ai_played_ms      milliseconds of audio that played. Less than the line's length if it was cut,
--                       and about 250 ms over on a line that was paused (what the pause dropped still
--                       counts), so never work an end out from it. Bot rows only.
--
-- ADDITIVE ONLY. No existing row is written: every row, phone or R1, keeps NULL in all three, and an
-- older interview simply has no end times. There is no backfill, because nothing recorded these facts
-- at the time. The R1 worker writes them from R1TurnWriter; the phone writer and the phone turn RPCs
-- do not name them, and no function is redeclared here, so the phone lane is unchanged. None of them
-- holds candidate speech, and DSAR export and erasure follow the row.
--
-- The CHECKs add no scan cost that matters: this is 0116's NOT VALID then VALIDATE on a small table,
-- and every existing row passes on NULL. May run while calls are live. Forward-only.
-- See r1-turn-timing-migration.test.ts.
set local lock_timeout = '10s';

alter table screening_v2.transcript_turns
  add column if not exists turn_ended_at_ms bigint null,
  add column if not exists ai_voice text null,
  add column if not exists ai_played_ms integer null;

alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_turn_ended_at_ms
    check (turn_ended_at_ms is null
           or (turn_ended_at_ms > 0
               and turn_ended_at_ms < 4102444800000
               and (turn_started_at_ms is null or turn_ended_at_ms >= turn_started_at_ms))) not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_turn_ended_at_ms;

alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_ai_voice
    check (ai_voice is null
           or (speaker = 'bot' and ai_voice in ('interviewer', 'learner'))) not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_ai_voice;

alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_ai_played_ms
    check (ai_played_ms is null
           or (speaker = 'bot' and ai_played_ms >= 0 and ai_played_ms <= 86400000)) not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_ai_played_ms;

comment on column screening_v2.transcript_turns.turn_ended_at_ms is
  'R1 only. Epoch ms the turn ended, on the same worker clock as turn_started_at_ms: when an AI row''s '
  'audio stopped (a line paused by the candidate''s voice and then cut ends at the pause), a candidate '
  'row''s voice-activity end of speech. NULL for phone rows, older R1 rows and any turn whose end was '
  'not known.';
comment on column screening_v2.transcript_turns.ai_voice is
  'R1 only. The voice that spoke this AI row: interviewer (Christy) or learner. NULL for candidate '
  'rows, phone rows, older R1 rows and a speech the worker could not tie to a voice.';
comment on column screening_v2.transcript_turns.ai_played_ms is
  'R1 only. Milliseconds of audio that played for this AI row, less than the line''s length when it '
  'was cut and about 250 ms over on a line that was paused, so not a way to work out its end. NULL for '
  'candidate rows, phone rows and older R1 rows.';

notify pgrst, 'reload schema';
