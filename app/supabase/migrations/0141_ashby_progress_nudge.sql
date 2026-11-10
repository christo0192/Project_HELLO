-- 0141: the Ashby progress worker's webhook nudge (M031 S4).
--
-- A candidateStageChange webhook for an application HELLO imported marks that
-- application's progress row due now, so the progress worker (0139,
-- app/api/src/integrations/ashby/progress-worker.ts) reads it on its next
-- pass instead of at its cadence (6 hours for a recently moved application).
-- The signal worker calls it before its stage pre-filter, only while
-- ASHBY_PROGRESS_ENABLED is on, as one call with no Ashby read, and carries on
-- whatever it answers (app/api/src/integrations/ashby/progress-nudge.ts). One
-- function, and nothing else:
--
--   nudge_ashby_application_progress(p_external_application_id, p_now)
--
-- WHAT IT DOES, in order:
--   1. refuses an id the link table could not hold (`invalid_request`);
--   2. finds the link on its unique key (provider, external_application_id):
--      none means HELLO never imported the application (`not_imported`), the
--      common case, and costs one index probe;
--   3. applies S3's one coverage rule, ashby_progress_covered_links(), never a
--      copy of it: a link a data-subject erasure ended, a link already ended
--      with no candidate left, and a link whose candidate has a restriction or
--      erasure request are never nudged (`not_covered`);
--   4. one write to ashby_application_progress: a missing row is created due
--      now, exactly as the claim seeds one (`created`); an existing row due
--      later is moved to now (`marked`); a row already due at or before now is
--      left alone (`already_due`). next_check_at only ever moves earlier, and
--      no other column of an existing row is touched: not the stored state,
--      not attempts, not the error code, and not updated_at, the mark a
--      backfill counts as "read since it began".
-- Idempotent: a second nudge answers `already_due` and writes nothing.
--
-- A ROW BEING READ. A claim holds a row by moving next_check_at to the end of
-- its lease. A nudge in that window moves it to now, so the read in flight
-- (which may predate the move) is refused as `lease_lost` and the next pass
-- reads the application again: the 0139 lease rule, as a backfill already
-- uses it. An application Ashby no longer had (next_check_at infinity) is due
-- once more: a stage change is proof it exists.
--
-- ADDITIVE ONLY. No table, column, view, index or existing function is
-- created, altered or dropped. ashby_application_links and the data-subject
-- requests (through the coverage rule) are read, never written; candidates and
-- assessments are not touched; no audit row is written (a webhook is not a
-- person's action, and the nudge changes no decision).
--
-- PRIVACY. It takes an opaque Ashby application id and a time, and answers a
-- status code: never an id.
--
-- SECURITY (the 0138 and 0139 posture): SECURITY DEFINER, pinned search_path,
-- executable by service_role only.

-- Fail fast rather than queue (the 0109 precedent). Creating a function takes
-- no lock on a table the workers write, but a stuck catalog lock must not
-- hold the deploy. LOCAL: scoped to this migration's transaction.
set local lock_timeout = '10s';

create or replace function screening_v2.nudge_ashby_application_progress(
  p_external_application_id text,
  p_now                     timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now  timestamptz := coalesce(p_now, now());
  v_link uuid;
  v_had  boolean;
  v_n    integer := 0;
begin
  if p_external_application_id is null or length(p_external_application_id) not between 1 and 256 then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- The link, on its unique key. None: HELLO never imported this application.
  select l.id into v_link
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby' and l.external_application_id = p_external_application_id;
  if not found then
    return jsonb_build_object('status', 'not_imported');
  end if;

  -- S3's coverage rule, only for a link that exists.
  if not exists (select 1 from screening_v2.ashby_progress_covered_links() c where c.link_id = v_link) then
    return jsonb_build_object('status', 'not_covered');
  end if;

  -- Whether the row existed, for the answer only: a claim seeding the same
  -- link at this instant changes the word, never the write.
  v_had := exists (select 1 from screening_v2.ashby_application_progress p where p.application_link_id = v_link);

  -- The one write: due now, never later than it already was.
  insert into screening_v2.ashby_application_progress as p
    (application_link_id, next_check_at, created_at, updated_at)
  values (v_link, v_now, v_now, v_now)
  on conflict (application_link_id) do update
     set next_check_at = excluded.next_check_at
   where p.next_check_at > excluded.next_check_at;
  get diagnostics v_n = row_count;

  return jsonb_build_object('status',
    case when v_n = 0 then 'already_due' when v_had then 'marked' else 'created' end);
end;
$$;

revoke all on function screening_v2.nudge_ashby_application_progress(text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.nudge_ashby_application_progress(text, timestamptz)
  to service_role;

comment on function screening_v2.nudge_ashby_application_progress(text, timestamptz) is
  '0141 (M031 S4): a stage-change webhook for an imported Ashby application '
  'marks its progress row due now (created if missing, as the claim seeds '
  'one), so the progress worker reads it on its next pass. next_check_at only '
  'ever moves earlier and nothing else on the row changes. Only links '
  'ashby_progress_covered_links() admits; an application HELLO never imported '
  'writes nothing. Answers a status code only: marked, created, already_due, '
  'not_imported, not_covered or invalid_request. Service-role only.';

notify pgrst, 'reload schema';
