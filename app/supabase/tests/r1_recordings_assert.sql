-- Executed by scripts/test-r1-recordings.sh inside scripts/supabase-test.sh's already-started local
-- Supabase stack, which has applied the complete 0001..0127 chain (no stubs). Covers migration
-- 0127 (R1 interview recordings): the recordings table and its constraints, the three triggers
-- (finalize enqueue, consent-withdrawal erase enqueue, delete -> purge outbox), the privileges and
-- search_path posture, and the r1_settings.recording_mode switch.
--
-- Fixture ids live in 7e000000-... and are self-contained: a role (reused when a sales_r1 role
-- exists) and an inactive consent template of their own, one candidate + round + session +
-- attempt per scenario. Everything is deleted again at the end.
create schema if not exists _r1_rec_tests;
create or replace function _r1_rec_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then raise exception 'R1 REC FAIL: % (%)', p_label, p_detail; end if;
  raise notice 'R1 REC PASS: %', p_label;
end;
$$;

-- Runs a statement that MUST raise the given SQLSTATE; any other outcome fails the assertion.
create or replace function _r1_rec_tests.raises(p_label text, p_sql text, p_sqlstate text)
returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform _r1_rec_tests.assert(p_label || ' (rejected with ' || p_sqlstate || ')',
      v_state = p_sqlstate, 'got ' || v_state);
    return;
  end;
  raise exception 'R1 REC FAIL: % (statement was accepted)', p_label;
end;
$$;

do $$
declare
  owner constant uuid := '7e000000-0000-4000-8000-000000000001';
  tpl constant uuid := '7e000000-0000-4000-8000-000000000003';
begin
  insert into auth.users (id, email) values (owner, 'r1-rec-assert@example.test')
  on conflict (id) do nothing;
  -- Inactive on purpose: this fixture must never become the authoritative template.
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (tpl, 'rec-fixture', 'en-IN', 'R1 REC fixture', 'fixture',
          '["video_audio_recording"]'::jsonb, false)
  on conflict (id) do nothing;
  if not exists (select 1 from screening_v2.roles where interview_kind = 'sales_r1') then
    insert into screening_v2.roles (id, title, interview_kind)
    values ('7e000000-0000-4000-8000-000000000002', 'R1 REC assertion role', 'sales_r1');
  end if;
end;
$$;

-- One scenario: candidate, in_progress round, `in_progress` browser session with its attempt, and
-- optionally a live consent. Returns the session id; the round id is _r1_rec_tests.round_of().
create or replace function _r1_rec_tests.fixture(p_n integer, p_consent boolean default true)
returns uuid
language plpgsql
as $$
declare
  owner constant uuid := '7e000000-0000-4000-8000-000000000001';
  tpl constant uuid := '7e000000-0000-4000-8000-000000000003';
  v_role uuid;
  v_candidate uuid := ('7e000000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_round uuid := ('7e000000-0000-4000-8000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
  v_session uuid := ('7e000000-0000-4000-8000-0000000003' || lpad(p_n::text, 2, '0'))::uuid;
begin
  select r.id into v_role from screening_v2.roles r where r.interview_kind = 'sales_r1' limit 1;
  insert into screening_v2.candidates (id, role_id, name)
  values (v_candidate, v_role, 'rec assert ' || p_n::text);
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
  values (v_round, v_candidate, v_role,
          encode(sha256(('r1-rec-link-' || p_n::text)::bytea), 'hex'),
          '2099-01-01 00:00:00+00', owner, 'in_progress');
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_session, v_candidate, v_role, 'browser', 'livekit',
          'screening-' || v_session::text, 'created', v_round, owner);
  -- A new session must start in `created`; the live R1 worker moves it to in_progress.
  update screening_v2.call_sessions set status = 'in_progress' where id = v_session;
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_session, v_round, 1, 'p1_career_switcher',
          encode(sha256(('r1-rec-nonce-' || p_n::text)::bytea), 'hex'));
  if p_consent then
    insert into screening_v2.interview_round_consents
      (round_id, template_id, consents, proof, withdrawn_at)
    values (v_round, tpl, '["video_audio_recording"]'::jsonb, '{"decision":"granted"}'::jsonb, null);
  end if;
  return v_session;
end;
$$;

create or replace function _r1_rec_tests.round_of(p_session uuid)
returns uuid language sql as $$
  select a.round_id from screening_v2.interview_round_attempts a where a.session_id = p_session;
$$;

-- A well-formed recording row for the fixture session (the shape the API inserts at prepare).
create or replace function _r1_rec_tests.add_recording(p_session uuid, p_status text default 'preparing')
returns void language plpgsql as $$
declare
  v_round uuid := _r1_rec_tests.round_of(p_session);
begin
  insert into screening_v2.interview_round_recordings
    (session_id, round_id, bucket, prefix, requested_mode, status, upload_id, delete_after,
     deleted_at)
  values (p_session, v_round, 'ik-r1-recordings',
          'r1/' || v_round::text || '/' || p_session::text || '/', 'av', p_status,
          case when p_status = 'deleted' then null else 'fake-upload-id-' || p_session::text end,
          now() + interval '90 days',
          case when p_status = 'deleted' then now() else null end);
end;
$$;

create or replace function _r1_rec_tests.jobs(p_name text, p_dedup text)
returns integer language sql as $$
  select count(*)::integer from screening_v2.job_queue where name = p_name and dedup_key = p_dedup;
$$;

-- 1. Catalog posture: tables, RLS, privileges, trigger functions.
do $$
declare
  fn text;
  tbl text;
begin
  foreach tbl in array array['interview_round_recordings', 'r1_recording_purge'] loop
    perform _r1_rec_tests.assert(tbl || ' has RLS enabled and no policy',
      (select relrowsecurity from pg_class where oid = ('screening_v2.' || tbl)::regclass)
      and not exists (select 1 from pg_policies where schemaname = 'screening_v2' and tablename = tbl));
    perform _r1_rec_tests.assert(tbl || ' is closed to anon, authenticated and public',
      not has_table_privilege('anon', 'screening_v2.' || tbl, 'select,insert,update,delete,truncate')
      and not has_table_privilege('authenticated', 'screening_v2.' || tbl, 'select,insert,update,delete,truncate')
      and not exists (
        select 1 from information_schema.role_table_grants g
         where g.table_schema = 'screening_v2' and g.table_name = tbl and g.grantee = 'PUBLIC'));
    perform _r1_rec_tests.assert(tbl || ' is fully available to service_role',
      has_table_privilege('service_role', 'screening_v2.' || tbl, 'select,insert,update,delete'));
  end loop;
  foreach fn in array array[
    'screening_v2.enqueue_r1_recording_finalize()',
    'screening_v2.enqueue_r1_recording_erase()',
    'screening_v2.purge_on_r1_recording_delete()'
  ] loop
    perform _r1_rec_tests.assert(fn || ' is security invoker with a pinned search_path',
      (select not p.prosecdef and p.proconfig @> array['search_path=pg_catalog']
         from pg_proc p where p.oid = fn::regprocedure));
    perform _r1_rec_tests.assert(fn || ' is not executable by anon, authenticated or public',
      not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
  perform _r1_rec_tests.assert('the three recording triggers exist and are enabled',
    (select count(*) from pg_trigger t
      where not t.tgisinternal and t.tgenabled = 'O'
        and t.tgname in ('enqueue_r1_recording_finalize', 'purge_on_r1_recording_delete',
                         'enqueue_r1_recording_erase')) = 3);
end;
$$;

-- 2. r1_settings.recording_mode: defaults off; the value space is off | audio | av.
do $$
begin
  perform _r1_rec_tests.assert('recording_mode defaults to off',
    (select recording_mode = 'off' from screening_v2.r1_settings where singleton));
  perform _r1_rec_tests.raises('recording_mode = video',
    $q$update screening_v2.r1_settings set recording_mode = 'video' where singleton$q$, '23514');
  perform _r1_rec_tests.raises('recording_mode = NULL',
    $q$update screening_v2.r1_settings set recording_mode = null where singleton$q$, '23502');
  update screening_v2.r1_settings set recording_mode = 'audio' where singleton;
  update screening_v2.r1_settings set recording_mode = 'av' where singleton;
  update screening_v2.r1_settings set recording_mode = 'off' where singleton;
  perform _r1_rec_tests.assert('off, audio and av are all accepted (reset to off)',
    (select recording_mode = 'off' from screening_v2.r1_settings where singleton));
end;
$$;

-- 3. Table constraints.
do $$
declare
  s1 uuid := _r1_rec_tests.fixture(1);
  s2 uuid := _r1_rec_tests.fixture(2);
  r1 uuid;
  r2 uuid;
  base text;
begin
  r1 := _r1_rec_tests.round_of(s1);
  r2 := _r1_rec_tests.round_of(s2);
  perform _r1_rec_tests.raises('a (session_id, round_id) pair that is not an attempt',
    format($q$insert into screening_v2.interview_round_recordings
      (session_id, round_id, bucket, prefix, requested_mode, delete_after)
      values (%L, %L, 'b', %L, 'av', now())$q$, s1, r2, 'r1/' || r2 || '/' || s1 || '/'), '23503');
  perform _r1_rec_tests.raises('a prefix that is not r1/<round>/<session>/',
    format($q$insert into screening_v2.interview_round_recordings
      (session_id, round_id, bucket, prefix, requested_mode, delete_after)
      values (%L, %L, 'b', %L, 'av', now())$q$, s1, r1, 'r1/' || s1 || '/' || r1 || '/'), '23514');

  perform _r1_rec_tests.add_recording(s1);
  perform _r1_rec_tests.assert('a well-formed row inserts with the documented defaults',
    (select status = 'preparing' and parts_issued = 0 and urls_issued = 0 and finalize_attempts = 0
            and layout is null and has_video is null and deleted_at is null
            and created_at is not null and updated_at is not null
       from screening_v2.interview_round_recordings where session_id = s1));
  perform _r1_rec_tests.raises('a second row for the same session',
    format($q$select _r1_rec_tests.add_recording(%L)$q$, s1), '23505');

  base := format($q$update screening_v2.interview_round_recordings set %%s where session_id = %L$q$, s1);
  perform _r1_rec_tests.raises('status outside the machine', format(base, $q$status = 'recording'$q$), '23514');
  perform _r1_rec_tests.raises('requested_mode video', format(base, $q$requested_mode = 'video'$q$), '23514');
  perform _r1_rec_tests.raises('layout outside the set', format(base, $q$layout = 'merged'$q$), '23514');
  perform _r1_rec_tests.raises('parts_issued 61', format(base, 'parts_issued = 61'), '23514');
  perform _r1_rec_tests.raises('urls_issued 401', format(base, 'urls_issued = 401'), '23514');
  perform _r1_rec_tests.raises('empty upload_id', format(base, $q$upload_id = ''$q$), '23514');
  perform _r1_rec_tests.raises('upload_id over 1024 characters',
    format(base, format($q$upload_id = %L$q$, repeat('x', 1025))), '23514');
  perform _r1_rec_tests.raises('a malformed video sha256', format(base, $q$video_sha256 = 'ABC'$q$), '23514');
  perform _r1_rec_tests.raises('video_content_type outside the allowlist',
    format(base, $q$video_content_type = 'video/webm'$q$), '23514');
  perform _r1_rec_tests.raises('started_at_ms before 2020', format(base, 'started_at_ms = 1000'), '23514');
  perform _r1_rec_tests.raises('failure_reason with upper case', format(base, $q$failure_reason = 'Upload_Failed'$q$), '23514');
  perform _r1_rec_tests.raises('degraded_reason with a space', format(base, $q$degraded_reason = 'frame drops'$q$), '23514');
  perform _r1_rec_tests.raises('delete_reason outside the set', format(base, $q$delete_reason = 'because'$q$), '23514');
  perform _r1_rec_tests.raises('fps above 60', format(base, 'fps = 61'), '23514');
  perform _r1_rec_tests.raises('width below 16', format(base, 'width = 8'), '23514');
  perform _r1_rec_tests.raises('a video_key outside the prefix',
    format(base, $q$video_key = 'r1/elsewhere/video.mp4'$q$), '23514');
  perform _r1_rec_tests.raises('an audio_key outside the prefix',
    format(base, $q$audio_key = 'audio.ogg'$q$), '23514');
  perform _r1_rec_tests.raises('status deleted without deleted_at', format(base, $q$status = 'deleted'$q$), '23514');
  perform _r1_rec_tests.raises('deleted_at on a live status', format(base, 'deleted_at = now()'), '23514');
  -- In-window values and keys under the prefix are accepted.
  execute format($q$update screening_v2.interview_round_recordings
    set video_key = prefix || 'video.mp4', audio_key = prefix || 'audio.ogg',
        video_sha256 = repeat('a', 64), video_content_type = 'video/mp4', started_at_ms = 1790000000000,
        duration_ms = 1320000, width = 640, height = 360, fps = 15, frames_encoded = 19800,
        frames_dropped = 12, camera_off_ms = 0, degraded_at_ms = 0, reported_parts = 60,
        reported_stream_bytes = 1048576, failure_reason = 'upload_failed', degraded_reason = 'cpu_loop_lag',
        delete_reason = 'retention'
    where session_id = %L$q$, s1);
  perform _r1_rec_tests.assert('in-window report values and keys under the prefix are accepted',
    (select video_key = prefix || 'video.mp4' and fps = 15 from screening_v2.interview_round_recordings where session_id = s1));
end;
$$;

-- 4. Finalize enqueue: recording -> 'finishing' queues exactly one job, atomically.
do $$
declare
  s1 uuid := '7e000000-0000-4000-8000-000000000301';
  s3 uuid := _r1_rec_tests.fixture(3);
  dk text;
begin
  dk := 'r1.recording.finalize:' || s1::text;
  perform _r1_rec_tests.assert('no finalize job exists before the status moves to finishing',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 0);
  update screening_v2.interview_round_recordings set status = 'uploading', updated_at = now() where session_id = s1;
  perform _r1_rec_tests.assert('preparing -> uploading queues nothing', _r1_rec_tests.jobs('r1.recording.finalize', dk) = 0);
  update screening_v2.interview_round_recordings set status = 'finishing', updated_at = now() where session_id = s1;
  perform _r1_rec_tests.assert('-> finishing queues exactly one finalize job with the documented shape',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 1
    and exists (select 1 from screening_v2.job_queue j
                 where j.dedup_key = dk and j.name = 'r1.recording.finalize' and j.max_attempts = 5
                   and j.status = 'pending' and j.payload = jsonb_build_object('session_id', s1)));
  update screening_v2.interview_round_recordings set status = 'finishing', failure_reason = 'upload_failed' where session_id = s1;
  update screening_v2.interview_round_recordings set finalize_attempts = 1 where session_id = s1;
  perform _r1_rec_tests.assert('a second update of a finishing row queues nothing more',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 1);

  -- The dedup index is partial over live jobs: once the job is done the SAME key is reusable,
  -- which is how a stuck finalize is re-driven (a re-entry into finishing queues a fresh job).
  update screening_v2.job_queue set status = 'completed', completed_at = now() where dedup_key = dk;
  update screening_v2.interview_round_recordings set status = 'ready' where session_id = s1;
  perform _r1_rec_tests.assert('leaving finishing queues nothing', _r1_rec_tests.jobs('r1.recording.finalize', dk) = 1);
  update screening_v2.interview_round_recordings set status = 'finishing' where session_id = s1;
  perform _r1_rec_tests.assert('re-entering finishing after the job completed queues a fresh job (dedup is live-only)',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 2
    and (select count(*) from screening_v2.job_queue where dedup_key = dk and status = 'pending') = 1);
  -- With NO live job to hide behind, finishing -> finishing must still queue nothing (the WHEN
  -- guard, not the dedup index, is what keeps the trigger to the transition INTO finishing).
  update screening_v2.job_queue set status = 'completed', completed_at = now() where dedup_key = dk;
  update screening_v2.interview_round_recordings set status = 'finishing', updated_at = now() where session_id = s1;
  perform _r1_rec_tests.assert('finishing -> finishing queues nothing even with no live job',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 2);

  -- An INSERT cannot use OLD, and a row only reaches finishing by an UPDATE.
  perform _r1_rec_tests.add_recording(s3, 'finishing');
  perform _r1_rec_tests.assert('inserting a row already in finishing queues nothing',
    _r1_rec_tests.jobs('r1.recording.finalize', 'r1.recording.finalize:' || s3::text) = 0);
end;
$$;

-- 5. The finalize trigger and the purge trigger run as the REAL runtime role (security invoker).
do $$
declare
  s4 uuid := _r1_rec_tests.fixture(4);
  dk text := 'r1.recording.finalize:7e000000-0000-4000-8000-000000000304';
begin
  perform _r1_rec_tests.add_recording(s4, 'uploading');
  set local role service_role;
  update screening_v2.interview_round_recordings set status = 'finishing', updated_at = now() where session_id = s4;
  reset role;
  perform _r1_rec_tests.assert('service_role: -> finishing queues the finalize job',
    _r1_rec_tests.jobs('r1.recording.finalize', dk) = 1);
  set local role service_role;
  delete from screening_v2.interview_round_recordings where session_id = s4;
  reset role;
  perform _r1_rec_tests.assert('service_role: a direct row delete leaves exactly one purge row',
    (select count(*) from screening_v2.r1_recording_purge where prefix like '%' || s4::text || '/') = 1);
end;
$$;

-- 5b. The consent trigger and the FK-cascade purge also work for the runtime role (service_role),
-- whose privileges the security-invoker trigger functions run with.
do $$
declare
  s13 uuid := _r1_rec_tests.fixture(13);
  s14 uuid := _r1_rec_tests.fixture(14);
  r13 uuid := _r1_rec_tests.round_of(s13);
  c13 uuid;
  p14 text;
begin
  select id into c13 from screening_v2.interview_round_consents where round_id = r13;
  set local role service_role;
  update screening_v2.interview_round_consents
     set withdrawn_at = now(), proof = coalesce(proof, '{}'::jsonb) || '{"decision":"withdrawn"}'::jsonb
   where id = c13;
  reset role;
  perform _r1_rec_tests.assert('service_role: a withdrawal queues the erase job',
    _r1_rec_tests.jobs('r1.recording.erase', 'r1.recording.erase:' || c13::text) = 1);

  perform _r1_rec_tests.add_recording(s14, 'uploading');
  p14 := (select prefix from screening_v2.interview_round_recordings where session_id = s14);
  set local role service_role;
  delete from screening_v2.candidates where id = '7e000000-0000-4000-8000-000000000114';
  reset role;
  perform _r1_rec_tests.assert('service_role: deleting a candidate (FK cascade) leaves one purge row',
    not exists (select 1 from screening_v2.interview_round_recordings where session_id = s14)
    and (select count(*) from screening_v2.r1_recording_purge where prefix = p14) = 1);
end;
$$;

-- 6. Erase enqueue: a consent WITHDRAWN or DECLINED queues the erase; SUPERSEDED never does.
do $$
declare
  s5 uuid := _r1_rec_tests.fixture(5);
  s6 uuid := _r1_rec_tests.fixture(6);
  s7 uuid := _r1_rec_tests.fixture(7);
  r5 uuid := _r1_rec_tests.round_of(s5);
  r6 uuid := _r1_rec_tests.round_of(s6);
  r7 uuid := _r1_rec_tests.round_of(s7);
  c5 uuid;
  c6 uuid;
  c7 uuid;
  res jsonb;
begin
  select id into c5 from screening_v2.interview_round_consents where round_id = r5;
  select id into c6 from screening_v2.interview_round_consents where round_id = r6;
  select id into c7 from screening_v2.interview_round_consents where round_id = r7;

  -- Superseded (r1-candidate.ts: a newer template replaces a live consent). Same UPDATE shape.
  update screening_v2.interview_round_consents
     set withdrawn_at = now(),
         proof = coalesce(proof, '{}'::jsonb) || jsonb_build_object('decision', 'superseded', 'superseded_at', now())
   where id = c5 and withdrawn_at is null;
  perform _r1_rec_tests.assert('a SUPERSEDED consent queues no erase job',
    _r1_rec_tests.jobs('r1.recording.erase', 'r1.recording.erase:' || c5::text) = 0
    and not exists (select 1 from screening_v2.job_queue where name = 'r1.recording.erase' and payload->>'round_id' = r5::text));

  -- Withdrawn through the real RPC (0120).
  res := screening_v2.r1_withdraw_consent(r6, '{}'::jsonb, now(), 'withdrawn');
  perform _r1_rec_tests.assert('r1_withdraw_consent(withdrawn) succeeded', res->>'status' = 'ok' and (res->>'withdrawn')::int = 1, res::text);
  perform _r1_rec_tests.assert('a WITHDRAWN consent queues exactly one erase job with the documented shape',
    _r1_rec_tests.jobs('r1.recording.erase', 'r1.recording.erase:' || c6::text) = 1
    and exists (select 1 from screening_v2.job_queue j
                 where j.dedup_key = 'r1.recording.erase:' || c6::text and j.name = 'r1.recording.erase'
                   and j.max_attempts = 5 and j.status = 'pending'
                   and j.payload = jsonb_build_object('round_id', r6, 'reason', 'consent_withdrawn')));
  res := screening_v2.r1_withdraw_consent(r6, '{}'::jsonb, now(), 'withdrawn');
  perform _r1_rec_tests.assert('replaying the withdrawal withdraws nothing and queues nothing more',
    (res->>'withdrawn')::int = 0 and _r1_rec_tests.jobs('r1.recording.erase', 'r1.recording.erase:' || c6::text) = 1, res::text);

  -- Declined through the same RPC.
  res := screening_v2.r1_withdraw_consent(r7, '{}'::jsonb, now(), 'declined');
  perform _r1_rec_tests.assert('a DECLINED consent queues exactly one erase job',
    (res->>'withdrawn')::int = 1 and _r1_rec_tests.jobs('r1.recording.erase', 'r1.recording.erase:' || c7::text) = 1, res::text);
end;
$$;

do $$
declare
  s8 uuid := _r1_rec_tests.fixture(8);
  r8 uuid := _r1_rec_tests.round_of(s8);
  c8 uuid;
  n_before integer;
begin
  select id into c8 from screening_v2.interview_round_consents where round_id = r8;
  select count(*) into n_before from screening_v2.job_queue where name = 'r1.recording.erase';

  update screening_v2.interview_round_consents set consents = '["recording"]'::jsonb where id = c8;
  perform _r1_rec_tests.assert('updating another consent column queues nothing',
    (select count(*) from screening_v2.job_queue where name = 'r1.recording.erase') = n_before);

  -- A withdrawn_at with NO decision in proof is not a withdrawal this trigger understands.
  update screening_v2.interview_round_consents set withdrawn_at = now(), proof = null where id = c8;
  perform _r1_rec_tests.assert('withdrawn_at without a decision queues nothing (never on withdrawn_at alone)',
    (select count(*) from screening_v2.job_queue where name = 'r1.recording.erase') = n_before);

  -- A decline with no prior consent is an INSERT of an already-withdrawn row: no recording can exist.
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, withdrawn_at)
  values (r8, '7e000000-0000-4000-8000-000000000003', '[]'::jsonb, '{"decision":"declined"}'::jsonb, now());
  perform _r1_rec_tests.assert('inserting an already-declined consent queues nothing',
    (select count(*) from screening_v2.job_queue where name = 'r1.recording.erase') = n_before);
end;
$$;

-- 7. Isolation from other lanes: phone sessions and the legacy recording.finalize.
do $$
declare
  owner constant uuid := '7e000000-0000-4000-8000-000000000001';
  v_role uuid;
  v_cand uuid := '7e000000-0000-4000-8000-000000000190';
  v_phone uuid := '7e000000-0000-4000-8000-000000000390';
  s9 uuid := _r1_rec_tests.fixture(9);
  n_before integer;
  n_legacy_before integer;
begin
  select r.id into v_role from screening_v2.roles r where r.interview_kind = 'sales_r1' limit 1;
  insert into screening_v2.candidates (id, role_id, name) values (v_cand, v_role, 'rec assert phone');
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, owner_id)
  values (v_phone, v_cand, v_role, 'live', 'plivo', 'created', owner);
  update screening_v2.call_sessions set status = 'in_progress' where id = v_phone;

  select count(*) into n_before from screening_v2.job_queue where name like 'r1.recording.%';
  select count(*) into n_legacy_before from screening_v2.job_queue where name = 'recording.finalize';
  update screening_v2.call_sessions set status = 'completed' where id = v_phone;
  update screening_v2.call_sessions set terminal_reason = 'conversation_complete' where id = v_phone;
  perform _r1_rec_tests.assert('a phone call_sessions update queues no r1.recording.* job',
    (select count(*) from screening_v2.job_queue where name like 'r1.recording.%') = n_before);

  -- An R1 session reaching completed enqueues r1.assessment (0116) but never the legacy
  -- recording.finalize: that trigger requires a recording_egress_id, which R1 rooms never have.
  update screening_v2.call_sessions set status = 'completed' where id = s9;
  perform _r1_rec_tests.assert('an R1 session reaching completed queues r1.assessment ...',
    _r1_rec_tests.jobs('r1.assessment', 'r1.assessment:' || s9::text) = 1);
  perform _r1_rec_tests.assert('... and no legacy recording.finalize, nor any r1.recording.* job',
    (select count(*) from screening_v2.job_queue where name = 'recording.finalize') = n_legacy_before
    and (select count(*) from screening_v2.job_queue where name like 'r1.recording.%') = n_before);
end;
$$;

-- 8. Purge outbox: every delete path (including FK cascades) that still has objects leaves a row.
do $$
declare
  s10 uuid := _r1_rec_tests.fixture(10);
  s11 uuid := _r1_rec_tests.fixture(11);
  s12 uuid := _r1_rec_tests.fixture(12);
  c10 uuid := '7e000000-0000-4000-8000-000000000110';
  c12 uuid := '7e000000-0000-4000-8000-000000000112';
  r11 uuid := _r1_rec_tests.round_of(s11);
  p_prefix text;
begin
  -- A live recording, then the CANDIDATE is deleted (candidate -> sessions -> attempts -> recordings).
  perform _r1_rec_tests.add_recording(s10, 'uploading');
  p_prefix := (select prefix from screening_v2.interview_round_recordings where session_id = s10);
  delete from screening_v2.candidates where id = c10;
  perform _r1_rec_tests.assert('deleting a candidate cascades the recording row away',
    not exists (select 1 from screening_v2.interview_round_recordings where session_id = s10));
  perform _r1_rec_tests.assert('...and leaves exactly ONE open purge row carrying bucket, prefix, upload id and reason',
    (select count(*) from screening_v2.r1_recording_purge where prefix = p_prefix) = 1
    and exists (select 1 from screening_v2.r1_recording_purge
                 where prefix = p_prefix and bucket = 'ik-r1-recordings' and reason = 'row_deleted'
                   and upload_id = 'fake-upload-id-' || s10::text and done_at is null and attempts = 0
                   and last_error_code is null and queued_at is not null));

  -- A ROUND delete (cascades attempts) behaves the same.
  perform _r1_rec_tests.add_recording(s11, 'ready');
  p_prefix := (select prefix from screening_v2.interview_round_recordings where session_id = s11);
  delete from screening_v2.interview_rounds where id = r11;
  perform _r1_rec_tests.assert('deleting a round leaves one purge row for its recording',
    (select count(*) from screening_v2.r1_recording_purge where prefix = p_prefix) = 1);

  -- A tombstoned row has no objects left: deleting it queues nothing.
  perform _r1_rec_tests.add_recording(s12, 'deleted');
  p_prefix := (select prefix from screening_v2.interview_round_recordings where session_id = s12);
  delete from screening_v2.candidates where id = c12;
  perform _r1_rec_tests.assert('deleting a tombstoned (deleted) recording queues no purge row',
    not exists (select 1 from screening_v2.interview_round_recordings where session_id = s12)
    and not exists (select 1 from screening_v2.r1_recording_purge where prefix = p_prefix));
end;
$$;

-- Clean up: the fixtures (rows, jobs, purge rows) are removed so later suites see what they expect.
do $$
begin
  -- Candidates first: deleting one with a live recording queues purge rows, removed right after.
  -- (The inactive consent template is immutable by trigger and stays, as in the other R1 suites.)
  delete from screening_v2.candidates where id::text like '7e000000-0000-4000-8000-0000000001%';
  delete from screening_v2.r1_recording_purge where prefix like 'r1/7e000000-%';
  delete from screening_v2.job_queue
   where (name like 'r1.recording.%' and (payload->>'session_id' like '7e000000-%' or payload->>'round_id' like '7e000000-%'))
      or (name in ('r1.assessment', 'recording.finalize') and payload->>'session_id' like '7e000000-%');
  perform _r1_rec_tests.assert('fixtures are gone',
    not exists (select 1 from screening_v2.candidates where id::text like '7e000000-%')
    and not exists (select 1 from screening_v2.interview_round_recordings where session_id::text like '7e000000-%')
    and not exists (select 1 from screening_v2.r1_recording_purge where prefix like 'r1/7e000000-%'));
end;
$$;

drop schema _r1_rec_tests cascade;
