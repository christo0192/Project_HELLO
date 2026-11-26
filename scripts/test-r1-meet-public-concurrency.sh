#!/usr/bin/env bash
# Isolated real-Postgres RACE checks for 0143 (M035 S01): the public R1 Meet booking create and move,
# called by two sessions at the same instant.
#
# WHY THIS EXISTS: a public booking link lets anyone holding it submit at any time, from any number of
# tabs. 0143's create takes an advisory lock on the candidate, then on the slot's IST day, and only
# under those locks re-checks the replay, counts the slot and the day and runs the refusal predicates;
# the move takes the IST-day locks (lower date first) before it counts. Those locks are the ONLY guard
# against two bookings for one candidate, a slot or a day over its limit, and two rounds from one
# double click. r1_meet_public_bookings_assert.sql proves every answer one call at a time inside one
# transaction, and every vitest suite mocks Supabase, so neither can see a race. Only two REAL
# sessions blocked on the same lock and then released together prove there is no double booking, no
# orphan round, consent or job, no deadlock and no unique violation.
#
# This spins a throwaway Postgres, applies EVERY migration in order (and 0143 a second time,
# idempotency), seeds r1_meet_public_concurrency_setup.sql, then for each scenario:
#   1. holds the contended advisory lock (the RPC's own key) in a blocker transaction;
#   2. starts every racer as its OWN psql session and waits (at most 30 s) until exactly that many
#      advisory-lock waits on the blocker's key are visible in pg_locks, so they truly contend;
#   3. releases the blocker, waits for every racer, and compares their answers (one winner, the
#      loser's exact refusal, no error of any kind);
#   4. asks the database (_r1mp.verify_create / _r1mp.verify_move) for the bookings, rounds, consents,
#      jobs and the month's hold, which must match the answers exactly.
# Scenarios: C1 one candidate from two tabs; C2 one request id from two tabs (a double click); C3 two
# candidates for one one-seat slot; C4 two candidates for one day at its public limit; C5 two moves
# into one one-seat slot.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${R1_MEET_PUBLIC_RACE_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="r1-meet-public-race-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"
readonly WORK="$(mktemp -d)"

log() { printf '[r1-meet-public-race] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }
cleanup() {
  exec 9>&- 2>/dev/null || true
  docker rm -f "$CTR" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

# A racer whose lock wait outlives this is a hang, not a slow runner: fail it with an error.
readonly RACER_OPTS='-c statement_timeout=60000'

psql_q() { docker exec -i "$CTR" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
psql_v() { docker exec "$CTR" psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "$1"; }

# Pull BEFORE the readiness clock starts (test-gate-transcript.sh: a slow pull ate the budget).
log "pulling ${IMAGE}..."
docker pull -q "$IMAGE" >/dev/null

log "starting ephemeral ${IMAGE}..."
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

# READINESS (scripts/test-r1-concurrency.sh): the image's entrypoint first runs a TEMPORARY server
# (unix socket only), stops it, then starts the real one, so the first pg_isready success can be the
# temporary server. The temporary server never listens on TCP, so a `select 1` over 127.0.0.1 only
# ever reaches the real one. Require three consecutive TCP successes, within 90 s, and fail fast
# (with the container's log) if the container exits.
ready=0
for _ in $(seq 1 90); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null || echo false)" != true ]; then
    log 'ERROR: the postgres container exited during startup:'
    docker logs "$CTR" 2>&1 | tail -40
    exit 1
  fi
  if [ "$(docker exec -e PGPASSWORD=postgres "$CTR" psql -h 127.0.0.1 -U postgres -d postgres -t -A -c 'select 1' 2>/dev/null || true)" = 1 ]; then
    ready=$((ready + 1))
    [ "$ready" -ge 3 ] && break
  else
    ready=0
  fi
  sleep 1
done
if [ "$ready" -lt 3 ]; then
  log 'ERROR: postgres never became ready (no stable TCP select 1 within 90 s):'
  docker logs "$CTR" 2>&1 | tail -40
  exit 1
fi
[ "$(psql_v 'select 1')" = 1 ] || { log 'ERROR: postgres is not answering on its unix socket.'; exit 1; }
log 'postgres is ready (3 consecutive TCP select 1)'

# The roles every migration grants to. Supabase provides these; a bare Postgres does not, and a
# missing one fails the FIRST grant rather than the statement that actually matters.
log 'creating the Supabase roles the migrations grant to...'
psql_q <<'SQL' >/dev/null
do $$
declare
  r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator',
                           'supabase_auth_admin','supabase_storage_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text
);
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000000ad', 'fixture-owner@example.test')
on conflict (id) do nothing;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text
);
alter table storage.objects enable row level security;
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
SQL

log 'applying every migration in order...'
for f in "$MIG"/*.sql; do
  docker cp "$f" "$CTR:/tmp/$(basename "$f")" >/dev/null
  if ! docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
        -f "/tmp/$(basename "$f")" >"$WORK/migrate.log" 2>&1; then
    log "ERROR: migration $(basename "$f") failed:"
    tail -30 "$WORK/migrate.log"
    exit 1
  fi
done

shopt -s nullglob
target=("$MIG"/0143_*.sql)
[ "${#target[@]}" -eq 1 ] || fail "expected exactly one 0143_*.sql, found ${#target[@]}"
log 'applying 0143 a second time (idempotency)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
  -f "/tmp/$(basename "${target[0]}")" >/dev/null 2>"$WORK/reapply.log" \
  || { cat "$WORK/reapply.log"; fail '0143 is not idempotent'; }

log 'seeding the public booking race fixtures and helpers...'
psql_q < "$TESTS/r1_meet_public_concurrency_setup.sql"

# ── The blocker ─────────────────────────────────────────────────────────────────────────────
# A transaction that holds ONE advisory lock, the exact key the RPC takes (0143:
# hashtextextended('r1_meet_public:candidate:' || id) or hashtextextended('r1_meet_public:day:' ||
# 'YYYY-MM-DD')). Racers started while it is open queue on that key; releasing it lets them all go.
BLOCKER_PID=''
blocker_open() {
  local app="$1" sql="$2" out="$3"
  local fifo="$WORK/$app.fifo"
  mkfifo "$fifo"
  docker exec -i -e "PGAPPNAME=$app" "$CTR" \
    psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 < "$fifo" > "$out" 2>&1 &
  BLOCKER_PID=$!
  exec 9>"$fifo"
  printf 'begin;\n%s\n' "$sql" >&9
  for _ in $(seq 1 100); do
    [ "$(psql_v "select count(*) from pg_stat_activity where application_name = '$app' and state = 'idle in transaction'")" = 1 ] && return 0
    sleep .1
  done
  fail "blocker $app never reached idle in transaction: $(cat "$out")"
}
blocker_commit() {
  printf 'commit;\n' >&9
  exec 9>&-
  wait "$BLOCKER_PID" || fail "the blocker transaction failed"
  BLOCKER_PID=''
}
# Wait (at most 30 s) until exactly $2 sessions whose application_name starts with $1 wait on the
# advisory lock the blocker $3 holds, and no other advisory wait exists anywhere.
await_advisory_waiters() {
  local prefix="$1" want="$2" blocker="$3" got=''
  for _ in $(seq 1 300); do
    got="$(psql_v "select (select count(*) from pg_locks w join pg_stat_activity a on a.pid = w.pid
                            where w.locktype = 'advisory' and not w.granted
                              and a.application_name like '${prefix}%'
                              and exists (select 1 from pg_locks h join pg_stat_activity b on b.pid = h.pid
                                           where h.locktype = 'advisory' and h.granted
                                             and b.application_name = '${blocker}'
                                             and h.database = w.database and h.classid = w.classid
                                             and h.objid = w.objid and h.objsubid = w.objsubid))
                           || ':' || (select count(*) from pg_locks w where w.locktype = 'advisory' and not w.granted)")"
    [ "$got" = "${want}:${want}" ] && return 0
    sleep .1
  done
  fail "${prefix}: racers waiting on the blocker's advisory lock : all advisory waits = ${got}, wanted ${want}:${want}"
}

# ── One race ────────────────────────────────────────────────────────────────────────────────
# race <tag> <lock key> <winning answer> <expected answers> <racer expression>...
# The blocker holds pg_advisory_xact_lock(hashtextextended('<lock key>', 0)); each racer runs
# `select 'racer:' || <expression>;` in its own session. The racers' answers, sorted, must equal
# <expected answers> exactly (so: one winner, the loser's exact refusal, no error, no deadlock, no
# unique violation). WINNER is set to the 0-based index of the racer that answered the winning answer.
WINNER=''
race() {
  local tag="$1" key="$2" win="$3" expect="$4"; shift 4
  local -a exprs=("$@") pids=()
  local n="${#exprs[@]}" i bad=0 got
  local dir="$WORK/$tag"; mkdir -p "$dir"
  WINNER=''
  blocker_open "r1mp-block-$tag" "select pg_advisory_xact_lock(hashtextextended('$key', 0));" "$dir/blocker.out"
  [ "$(psql_v "select count(*) from pg_locks h join pg_stat_activity b on b.pid = h.pid
                where h.locktype = 'advisory' and h.granted and b.application_name = 'r1mp-block-$tag'")" = 1 ] \
    || fail "$tag: the blocker does not hold exactly one advisory lock"
  for ((i = 0; i < n; i++)); do
    docker exec -e "PGAPPNAME=r1mp-race-$tag-$i" -e "PGOPTIONS=$RACER_OPTS" "$CTR" \
      psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "select 'racer:' || ${exprs[$i]};" \
      > "$dir/racer.$i" 2>&1 &
    pids+=("$!")
  done
  await_advisory_waiters "r1mp-race-$tag-" "$n" "r1mp-block-$tag"
  blocker_commit
  for ((i = 0; i < n; i++)); do
    if ! wait "${pids[$i]}"; then bad=1; fi
  done
  got="$(for ((i = 0; i < n; i++)); do tr -d '\n' < "$dir/racer.$i"; printf '\n'; done | LC_ALL=C sort | tr '\n' ' ')"
  got="${got% }"
  for ((i = 0; i < n; i++)); do
    if [ "$(cat "$dir/racer.$i")" = "racer:$win" ] && [ -z "$WINNER" ]; then WINNER="$i"; fi
    if grep -Eqi 'deadlock detected|duplicate key value|violates|error' "$dir/racer.$i"; then bad=1; fi
  done
  if [ "$bad" -ne 0 ] || [ "$got" != "$expect" ] || [ -z "$WINNER" ]; then
    log "racer answers for $tag:"
    for ((i = 0; i < n; i++)); do printf '  racer %s (%s): %s\n' "$i" "${exprs[$i]}" "$(tr '\n' ' ' < "$dir/racer.$i")"; done
    fail "$tag: expected exactly '${expect}', got '${got}'; every racer must answer cleanly (no error, deadlock or unique violation)"
  fi
  [ "$(psql_v "select count(*) from pg_locks where locktype = 'advisory'")" = 0 ] \
    || fail "$tag: an advisory lock outlived its transaction"
  log "PASS: $tag — $n simultaneous sessions on one advisory lock: ${got}, no error"
}

cand() { psql_v "select _r1mp.id(10, $1)"; }

# C1 — one candidate, two tabs (two request ids, two booking ids), one two-seat slot of IST
#      2026-12-02. Both wait on the candidate lock; the second finds the first's live booking.
race c1-two-tabs "r1_meet_public:candidate:$(cand 1)" 'booked:created' \
  'racer:booked:created racer:refused:already_booked' \
  "_r1mp.create(1, 11, 11, '2026-12-02 05:00:00+00', '2026-12-02 05:45:00+00', 2, 20)" \
  "_r1mp.create(1, 12, 12, '2026-12-02 05:00:00+00', '2026-12-02 05:45:00+00', 2, 20)"
c1=(11 12)
psql_q -c "select _r1mp.verify_create('c1-two-tabs', array[1], array[11, 12], array[11, 12], ${c1[$WINNER]});" >/dev/null
log "PASS: C1 verified — booking ${c1[$WINNER]} won; one booking, round, live consent and three jobs; nothing for the other tab"

# C2 — one request id from two tabs (a double click) with two booking ids, IST 2026-12-03. Both pass
#      the replay check before the lock; under it, the second answers replayed (never already_booked).
race c2-same-request "r1_meet_public:candidate:$(cand 2)" 'booked:created' \
  'racer:booked:created racer:replayed:' \
  "_r1mp.create(2, 21, 20, '2026-12-03 05:00:00+00', '2026-12-03 05:45:00+00', 2, 20)" \
  "_r1mp.create(2, 22, 20, '2026-12-03 05:00:00+00', '2026-12-03 05:45:00+00', 2, 20)"
c2=(21 22)
psql_q -c "select _r1mp.verify_create('c2-same-request', array[2], array[21, 22], array[20, 20], ${c2[$WINNER]});" >/dev/null
log "PASS: C2 verified — booking ${c2[$WINNER]} won; the replay wrote nothing"

# C3 — two candidates, one one-seat slot of IST 2026-12-04. Each takes its own candidate lock, both
#      wait on the day lock; the second counts the first's booking in the slot.
race c3-one-seat 'r1_meet_public:day:2026-12-04' 'booked:created' \
  'racer:booked:created racer:refused:slot_full' \
  "_r1mp.create(3, 31, 31, '2026-12-04 05:00:00+00', '2026-12-04 05:45:00+00', 1, 20)" \
  "_r1mp.create(4, 32, 32, '2026-12-04 05:00:00+00', '2026-12-04 05:45:00+00', 1, 20)"
c3=(31 32)
psql_q -c "select _r1mp.verify_create('c3-one-seat', array[3, 4], array[31, 32], array[31, 32], ${c3[$WINNER]});" >/dev/null
log "PASS: C3 verified — booking ${c3[$WINNER]} won the seat; nothing for the other candidate"

# C4 — two candidates, two different slots of IST 2026-12-05, a public day limit of 1. Both wait on
#      the day lock; the second counts the first's booking in the day.
race c4-public-day-limit 'r1_meet_public:day:2026-12-05' 'booked:created' \
  'racer:booked:created racer:refused:day_full' \
  "_r1mp.create(5, 41, 41, '2026-12-05 05:00:00+00', '2026-12-05 05:45:00+00', 2, 1)" \
  "_r1mp.create(6, 42, 42, '2026-12-05 07:00:00+00', '2026-12-05 07:45:00+00', 2, 1)"
c4=(41 42)
psql_q -c "select _r1mp.verify_create('c4-public-day-limit', array[5, 6], array[41, 42], array[41, 42], ${c4[$WINNER]});" >/dev/null
log "PASS: C4 verified — booking ${c4[$WINNER]} took the day's one public place; nothing for the other candidate"

# C5 — the two setup bookings of IST 2026-12-09 (51, 52) both move into one one-seat slot of IST
#      2026-12-08. The lower date is the target's, so both moves wait on that day lock first; the
#      second counts the first's moved booking in the slot and leaves its own booking as it was.
race c5-move-one-seat 'r1_meet_public:day:2026-12-08' 'moved:' \
  'racer:moved: racer:refused:slot_full' \
  "_r1mp.move(51, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00', 1)" \
  "_r1mp.move(52, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00', 1)"
c5=(51 52)
psql_q -c "select _r1mp.verify_move('c5-move-one-seat', ${c5[$WINNER]}, ${c5[$((1 - WINNER))]}, '2026-12-08 05:00:00+00', '2026-12-08 05:45:00+00');" >/dev/null
log "PASS: C5 verified — booking ${c5[$WINNER]} moved; booking ${c5[$((1 - WINNER))]} untouched"

log 'PASS: 0143 under real parallel sessions — two tabs, a double click, a one-seat slot, a full public day and two moves into one seat each end with exactly one booking, round, live consent and job set, no deadlock, no unique violation'
