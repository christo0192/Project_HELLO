-- =====================================================================
-- 0115 assertions, part 2 — the BACKFILLS, run right after the FIRST apply
-- of 0115 over the history phone_0115_setup.sql seeded under 0076.
--
-- Proves by execution:
--   * §2: the reconnect leg bound with room_name NULL now carries
--     'phone-<session_id>', and the backfill changed nothing else on the row
--     (0055's answered_at trigger did not fire);
--   * §3: two_legs 443 -> 75 s with 1 unobserved leg; only 360 -> NULL with 1
--     unobserved leg; clean and late untouched (duration_unobserved_legs
--     stays NULL) — and every one of those UPDATEs landed on a TERMINAL
--     (`completed`) session row.
-- Then it snapshots updated_at so phone_0115_assert.sql can prove the SECOND
-- apply of 0115 changed no row (idempotent backfills).
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_got  jsonb;
  v_n    integer;
  v_sess uuid;
  v_room text;
  v_ans  timestamptz;
begin
  -- ── §3 backfill: durations and unobserved counts ───────────────────
  select jsonb_object_agg(p.slug, jsonb_build_array(s.status, s.duration_sec, s.duration_unobserved_legs))
    into v_got
    from _p115.snap p join screening_v2.call_sessions s on s.id = p.session_id;
  if v_got <> jsonb_build_object(
       'two_legs', jsonb_build_array('completed', 75, 1),
       'only',     jsonb_build_array('completed', null, 1),
       'clean',    jsonb_build_array('completed', 90, null),
       'late',     jsonb_build_array('completed', 120, null)) then
    raise exception 'p115 backfill: unexpected (status, duration_sec, unobserved) per session: %', v_got;
  end if;

  -- ── §2 backfill: the reconnect leg's room name ─────────────────────
  select session_id into v_sess from _p115.snap where slug = 'two_legs';
  select room_name, answered_at into v_room, v_ans
    from screening_v2.phone_call_attempts
   where session_id = v_sess and attempt_seq = 2;
  if v_room is distinct from 'phone-' || v_sess::text then
    raise exception 'p115 backfill: reconnect leg room_name is %, expected phone-<session>', v_room;
  end if;
  if v_ans <> '2026-10-05T03:34:49.600Z'::timestamptz then
    raise exception 'p115 backfill: the room_name backfill moved answered_at to %', v_ans;
  end if;

  -- No bound leg anywhere is left without a room name.
  select count(*) into v_n
    from screening_v2.phone_call_attempts
   where session_id is not null and room_name is null;
  if v_n <> 0 then
    raise exception 'p115 backfill: % bound attempt(s) still have no room_name', v_n;
  end if;
end $$;

-- Snapshot for the idempotency check after the second apply.
update _p115.snap p
   set updated_at = s.updated_at
  from screening_v2.call_sessions s
 where s.id = p.session_id;

select 'p115 backfill asserted' as stage;
