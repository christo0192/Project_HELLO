#!/usr/bin/env bash
# Isolated real-Postgres CONCURRENCY simulation for 0131 (M019, PR #378): up to 15 R1 browser
# interviews live at once.
#
# WHY THIS EXISTS: 0131's whole claim is about racing callers. r1_admit_attempt lets
# least(max_concurrent_sessions, greatest(browser pool, 1)) sessions be live on the self-hosted
# target (1 on Cloud), and says the count "runs under the settings-row lock that every admission
# takes first, so racing admissions cannot overshoot the limit". r1_foundation_assert.sql proves
# the rule one call at a time, inside one transaction; every vitest suite mocks Supabase. Only
# many REAL sessions calling at the same instant prove there is no overshoot, no unique violation
# from uq_call_sessions_interview_round_live, no deadlock and no double charge.
#
# This spins a throwaway Postgres, applies EVERY migration in order (and 0131 a second time,
# idempotency), seeds r1_concurrency_setup.sql, then for each scenario:
#   1. prepares its rounds, limit, target and pool (one SQL call);
#   2. holds the r1_settings row in a blocker transaction, starts every racer as its OWN psql
#      session, and waits until all of them are blocked on that lock, so they truly contend;
#   3. releases the blocker, waits for every racer, and counts their answers;
#   4. asks the database (_r1c.verify) for the sessions, attempts, starts, budget and capacity
#      snapshot, which must match the answers exactly: 65 minutes per admitted round, once.
# Then retire_voice_worker races claim_voice_worker on one stopped lease row, both orders forced
# and 25 free-running races: never both succeed, the row ends either retired or claimed.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${R1_CONCURRENCY_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="r1-concurrency-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"
readonly WORK="$(mktemp -d)"

log() { printf '[r1-concurrency] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
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

# READINESS. The sibling harnesses break on the first `pg_isready` success. The image's entrypoint
# first runs a TEMPORARY server (initdb + init scripts, unix socket only), stops it, then starts
# the real one, so pg_isready can succeed against the temporary server and the very next command
# hits the restart: on PR #378 (run 39777848675) gate-transcript-test and role-drafts-index-test
# failed "postgres never became ready" 1.4 s after `docker run`, not 60 s. The temporary server
# never listens on TCP (listen_addresses=''), so a `select 1` over 127.0.0.1 only ever reaches
# the real one. Require three consecutive TCP successes, within 90 s, and fail fast (with the
# container's log) if the container exits.
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
target=("$MIG"/0131_*.sql)
[ "${#target[@]}" -eq 1 ] || fail "expected exactly one 0131_*.sql, found ${#target[@]}"
log 'applying 0131 a second time (idempotency)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
  -f "/tmp/$(basename "${target[0]}")" >/dev/null 2>"$WORK/reapply.log" \
  || { cat "$WORK/reapply.log"; fail '0131 is not idempotent'; }

log 'seeding the concurrency fixtures and helpers...'
psql_q < "$TESTS/r1_concurrency_setup.sql"

# ── The blocker ─────────────────────────────────────────────────────────────────────────────
# A transaction that holds the r1_settings row (FOR UPDATE), the first lock every admission
# takes. Racers started while it is open queue on that row; releasing it lets them all go.
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
# Wait until exactly $2 sessions whose application_name starts with $1 are waiting on a lock.
await_lock_waiters() {
  local prefix="$1" want="$2" got=0
  for _ in $(seq 1 300); do
    got="$(psql_v "select count(*) from pg_stat_activity where application_name like '${prefix}%' and wait_event_type = 'Lock'")"
    [ "$got" = "$want" ] && return 0
    sleep .1
  done
  fail "${prefix}: only ${got} of ${want} racers ever waited on the lock together"
}

# ── One admission race ──────────────────────────────────────────────────────────────────────
# race <tag> <expected ok> <allowed refusal regex> <round index>... : one racer per index (an
# index may repeat: the same round from two tabs). Every racer's answer must be `ok` or match the
# refusal regex; anything else (an error, a unique violation, a deadlock) fails the job.
race() {
  local tag="$1" want_ok="$2" refusal="$3"; shift 3
  local -a idx=("$@") pids=()
  local n="${#idx[@]}" i k round at bad=0 ok=0 refused=0
  local dir="$WORK/$tag"; mkdir -p "$dir"
  at="$(psql_v "select scenario_at from _r1c.scenarios where tag = '$tag'")"
  [ -n "$at" ] || fail "$tag: scenario not prepared"
  blocker_open "r1c-block-$tag" 'select 1 from screening_v2.r1_settings where singleton for update;' "$dir/blocker.out"
  for ((i = 0; i < n; i++)); do
    k="${idx[$i]}"
    round="$(psql_v "select round_id from _r1c.rounds where tag = '$tag' and k = $k")"
    [ -n "$round" ] || fail "$tag: no round $k"
    docker exec -e "PGAPPNAME=r1c-race-$tag-$i" -e "PGOPTIONS=$RACER_OPTS" "$CTR" \
      psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c \
      "select 'racer:' || (screening_v2.r1_admit_attempt('$round'::uuid, _r1c.digest('$tag-nonce-$i'), '$at'::timestamptz)->>'status')" \
      > "$dir/racer.$i" 2>&1 &
    pids+=("$!")
  done
  await_lock_waiters "r1c-race-$tag-" "$n"
  blocker_commit
  for ((i = 0; i < n; i++)); do
    if ! wait "${pids[$i]}"; then bad=1; fi
  done
  for ((i = 0; i < n; i++)); do
    if [ "$(cat "$dir/racer.$i")" = 'racer:ok' ]; then
      ok=$((ok + 1))
    elif grep -Eqx "racer:(${refusal})" "$dir/racer.$i"; then
      refused=$((refused + 1))
    else
      bad=1
    fi
  done
  if [ "$bad" -ne 0 ] || [ "$ok" -ne "$want_ok" ] || [ $((ok + refused)) -ne "$n" ]; then
    log "racer answers for $tag:"
    for ((i = 0; i < n; i++)); do printf '  racer %s (round %s): %s\n' "$i" "${idx[$i]}" "$(tr '\n' ' ' < "$dir/racer.$i")"; done
    fail "$tag: expected exactly ${want_ok} ok and $((n - want_ok)) refused as ${refusal}, got ${ok} ok and ${refused} refused, every racer must answer cleanly"
  fi
  psql_q -c "select _r1c.verify('$tag', $want_ok);" >/dev/null
  log "PASS: $tag — $n simultaneous admissions: exactly $ok ok, $refused refused ($refusal), no error"
}

seq_list() { local i; for ((i = 1; i <= $1; i++)); do printf '%s ' "$i"; done; }

# scenario <tag> <seq> <at> <target> <limit|null> <pool> <rounds>
scenario() {
  psql_q -c "select _r1c.scenario('$1', $2, '$3'::timestamptz, '$4', $5, $6, $7);" >/dev/null
}

# (1) limit 3, pool 3: twelve different rounds at once -> exactly three live.
scenario s1-limit3-pool3 1 '2046-01-15T12:00:00Z' r1 3 3 12
# shellcheck disable=SC2046
race s1-limit3-pool3 3 'r1_in_flight' $(seq_list 12)

# (2) limit 15 (the owner cap), pool 15: twenty at once -> exactly fifteen.
scenario s2-limit15-pool15 2 '2046-02-15T12:00:00Z' r1 15 15 20
# shellcheck disable=SC2046
race s2-limit15-pool15 15 'r1_in_flight' $(seq_list 20)

# (3) limit 15, pool 4: the pool caps it -> exactly four (the five noise lease rows never count).
scenario s3-limit15-pool4 3 '2046-03-15T12:00:00Z' r1 15 4 10
# shellcheck disable=SC2046
race s3-limit15-pool4 4 'r1_in_flight' $(seq_list 10)

# (4) Cloud target, limit 15, pool 15 -> exactly one, whatever the setting says.
scenario s4-cloud-limit15 4 '2046-04-15T12:00:00Z' cloud 15 15 12
# shellcheck disable=SC2046
race s4-cloud-limit15 1 'r1_in_flight' $(seq_list 12)

# (5) the shipped default (column default 1), pool 3: ten rounds, rounds 1 and 2 from two tabs
#     each -> exactly one, and every other racer answers exactly as 0128 did: r1_in_flight (never
#     round_live, which cannot appear until the limit is raised).
scenario s5-default-limit1 5 '2046-05-15T12:00:00Z' r1 null 3 10
# shellcheck disable=SC2046
race s5-default-limit1 1 'r1_in_flight' 1 1 2 2 $(seq 3 10 | tr '\n' ' ')

# (6) limit 3, pool 3: the SAME round from five sessions -> exactly one, the others round_live,
#     and no unique violation from uq_call_sessions_interview_round_live.
scenario s6-same-round 6 '2046-06-15T12:00:00Z' r1 3 3 1
race s6-same-round 1 'round_live' 1 1 1 1 1

# (6b) limit 3, pool 3: eight rounds, rounds 1-4 from two tabs each (twelve racers) -> exactly
#      three admitted rounds; every other racer is r1_in_flight or round_live.
scenario s6b-mixed-tabs 7 '2046-07-15T12:00:00Z' r1 3 3 8
race s6b-mixed-tabs 3 'r1_in_flight|round_live' 1 1 2 2 3 3 4 4 5 6 7 8

# (7) is asserted inside every race above by _r1c.verify: the month's minutes_used is 65 x the
#     admitted rounds, minutes_reserved 65 x the rest, starts_admitted the admitted count, and the
#     capacity snapshot agrees (no double charge, no lost hold).

# ── (8) retire_voice_worker vs claim_voice_worker on one stopped lease row ───────────────────
readonly RACE_APP='r1c-retire-race'
lease_reset() {
  psql_q -c "delete from screening_v2.voice_worker_leases where app = '$RACE_APP';
    insert into screening_v2.voice_worker_leases (app, machine_id, pipeline, state, claimed_session_id, epoch)
    values ('$RACE_APP', '$1', 'browser', 'stopped', null, 0);"
}
lease_state() {
  psql_v "select coalesce((select state || ':' || coalesce(claimed_session_id::text, '-')
            from screening_v2.voice_worker_leases where app = '$RACE_APP' and machine_id = '$1'), 'absent')"
}
claim_sql() { printf "select 'claim:' || (screening_v2.claim_voice_worker('%s', 'browser', '%s'::uuid)->>'status');" "$RACE_APP" "$2"; }
retire_sql() { printf "select 'retire:' || (screening_v2.retire_voice_worker('%s', '%s')->>'status');" "$RACE_APP" "$1"; }

# (8a) The claim commits while retire waits on the row: retire must re-check the state under the
#      row lock and answer not_stopped; the row stays claimed.
sid_a='c1310000-0000-4000-8000-00000000a001'
lease_reset r1cracea
blocker_open r1c-claim-first "$(claim_sql r1cracea "$sid_a")" "$WORK/claim-first.out"
docker exec -e PGAPPNAME=r1c-retire-waits -e "PGOPTIONS=$RACER_OPTS" "$CTR" \
  psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "$(retire_sql r1cracea)" > "$WORK/retire-waits.out" 2>&1 &
retire_pid=$!
await_lock_waiters r1c-retire-waits 1
blocker_commit
wait "$retire_pid" || fail "(8a) retire errored: $(cat "$WORK/retire-waits.out")"
[ "$(tr -d '\n' < "$WORK/claim-first.out")" = 'claim:claimed' ] \
  && [ "$(cat "$WORK/retire-waits.out")" = 'retire:not_stopped' ] \
  && [ "$(lease_state r1cracea)" = "starting:$sid_a" ] \
  || fail "(8a) claim-first: claim=$(cat "$WORK/claim-first.out") retire=$(cat "$WORK/retire-waits.out") row=$(lease_state r1cracea)"
log 'PASS: (8a) a claim that wins keeps its row: the waiting retire answers not_stopped'

# (8b) Retire holds the row (deleted, uncommitted) while the claim runs: the claim must not hand
#      that machine out (SKIP LOCKED: no_capacity), and the row ends retired.
sid_b='c1310000-0000-4000-8000-00000000b001'
lease_reset r1craceb
blocker_open r1c-retire-first "$(retire_sql r1craceb)" "$WORK/retire-first.out"
docker exec -e PGAPPNAME=r1c-claim-during -e "PGOPTIONS=$RACER_OPTS" "$CTR" \
  psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "$(claim_sql r1craceb "$sid_b")" > "$WORK/claim-during.out" 2>&1 \
  || fail "(8b) claim errored: $(cat "$WORK/claim-during.out")"
blocker_commit
[ "$(tr -d '\n' < "$WORK/retire-first.out")" = 'retire:retired' ] \
  && [ "$(cat "$WORK/claim-during.out")" = 'claim:no_capacity' ] \
  && [ "$(lease_state r1craceb)" = absent ] \
  || fail "(8b) retire-first: retire=$(cat "$WORK/retire-first.out") claim=$(cat "$WORK/claim-during.out") row=$(lease_state r1craceb)"
log 'PASS: (8b) a retire in flight is never handed out: the concurrent claim answers no_capacity'

# (8c) Free-running: both started together, 25 times on a fresh stopped row. Exactly one wins.
retired_wins=0; claimed_wins=0
for i in $(seq 1 25); do
  machine="r1cfree$i"; sid="$(printf 'c1310000-0000-4000-8000-0000000c%04d' "$i")"
  lease_reset "$machine"
  docker exec -e "PGOPTIONS=$RACER_OPTS" "$CTR" bash -c "
    psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c \"$(claim_sql "$machine" "$sid")\" > /tmp/r1c-claim.out 2>&1 &
    c=\$!
    psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c \"$(retire_sql "$machine")\" > /tmp/r1c-retire.out 2>&1 &
    r=\$!
    wait \$c; ec=\$?; wait \$r; er=\$?
    echo \"\$(cat /tmp/r1c-claim.out) \$(cat /tmp/r1c-retire.out) \$ec \$er\"" > "$WORK/free.out" 2>&1 \
    || fail "(8c) race $i: the racers did not run: $(cat "$WORK/free.out")"
  outcome="$(cat "$WORK/free.out") $(lease_state "$machine")"
  case "$outcome" in
    "claim:no_capacity retire:retired 0 0 absent") retired_wins=$((retired_wins + 1)) ;;
    "claim:claimed retire:not_stopped 0 0 starting:$sid") claimed_wins=$((claimed_wins + 1)) ;;
    *) fail "(8c) race $i: not exactly one winner (claim retire claim-exit retire-exit row): $outcome" ;;
  esac
done
psql_q -c "delete from screening_v2.voice_worker_leases where app = '$RACE_APP';"
log "PASS: (8c) 25 free-running retire/claim races: exactly one winner each (retire ${retired_wins}, claim ${claimed_wins})"

log 'PASS: 0131 under real parallel sessions — limits 3/15/pool-capped/Cloud/default hold exactly, a second tab is round_live, 65 minutes per admitted round, retire never races a claim'
