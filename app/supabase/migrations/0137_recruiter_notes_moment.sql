-- 0137 — Recruiter notes tied to a moment in an R1 recording.
--
-- WHY. A note has only ever been about a candidate (0015). A reviewer watching an R1 interview wants to
-- pin a thought to the second it happened, find it again on the timeline and play it to a colleague.
-- M026 R1-REVIEW-PLAN.md, PR 6.
--
-- WHAT. Three nullable columns, no default:
--   * round_id    the interview round the note is about.
--   * session_id  the attempt it is about: one session of that round.
--   * media_ms    milliseconds into that attempt's recording.
-- A note with none of them is the candidate note it has always been, and every note written so far
-- stays exactly that. A time needs an attempt and an attempt needs a round: two CHECKs hold the shape.
-- That the attempt belongs to the round and the round to the candidate is checked by the only writer,
-- routes/notes.ts (browser roles have no grant on this table, 0015).
--
-- NO FOREIGN KEYS, ON PURPOSE. 0015's guard refuses every UPDATE here, and every DELETE while the
-- candidate stands. So ON DELETE SET NULL would turn deleting a round or a session into a refused
-- UPDATE, and ON DELETE CASCADE into a refused DELETE: a note would block the delete of what it names.
-- NO ACTION blocks it too, and inside a candidate's erasure it would hang on the order the cascades
-- fire in, since call_sessions' key on candidates is older than this table's. A key would also take a
-- lock on call_sessions, which live calls write to. Nothing deletes a round or a session on its own
-- today, but a note must never be the reason it cannot. author_id has had no key since 0015 either. If
-- an id here ever outlives its row the note is still the candidate's, and it reads as a note with no
-- moment. An erasure still takes every note with the candidate, through 0015's cascade.
--
-- ADDITIVE ONLY. No existing row is written: no backfill, and the append-only guard is neither fired
-- nor opened (ADD COLUMN and VALIDATE write no row). No index: one round's notes are read through the
-- candidate, on 0015's (candidate_id, created_at), which is a handful of rows.
--
-- The CHECKs add no scan cost that matters: this is 0116's NOT VALID then VALIDATE on a small table, and
-- every existing row passes on NULL. May run while calls are live. Forward-only.
-- See recruiter-notes-moment-migration.test.ts.
set local lock_timeout = '10s';

alter table screening_v2.recruiter_notes
  add column if not exists round_id uuid null,
  add column if not exists session_id uuid null,
  add column if not exists media_ms integer null;

alter table screening_v2.recruiter_notes
  add constraint chk_recruiter_notes_session_needs_round
    check (session_id is null or round_id is not null) not valid;
alter table screening_v2.recruiter_notes
  validate constraint chk_recruiter_notes_session_needs_round;

alter table screening_v2.recruiter_notes
  add constraint chk_recruiter_notes_media_ms
    check (media_ms is null
           or (session_id is not null and media_ms >= 0 and media_ms <= 86400000)) not valid;
alter table screening_v2.recruiter_notes
  validate constraint chk_recruiter_notes_media_ms;

comment on column screening_v2.recruiter_notes.round_id is
  'The interview round this note is about, checked by the API on write. NULL for a note on the candidate '
  'alone, which is every note written before 0137.';
comment on column screening_v2.recruiter_notes.session_id is
  'The attempt this note is about: one session of round_id, checked by the API on write. NULL when the '
  'note names no attempt.';
comment on column screening_v2.recruiter_notes.media_ms is
  'Milliseconds into that attempt''s recording, from the reviewer''s playhead. NULL when the note has no '
  'moment, for example on an attempt with no recording.';

notify pgrst, 'reload schema';
