#!/usr/bin/env bash
# R1 assertions run inside scripts/supabase-test.sh's already-started local
# Supabase stack. It has applied the complete 0001..latest chain: never use stubs.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-foundation] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { rm -f "${R1_FIFO:-}" "${R1_OUT:-}"; }
trap cleanup EXIT INT TERM

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 assertions against the complete 0001..latest schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_foundation_assert.sql"

# The month row is deliberately absent before this race. A blocker owns the
# settings row, so two first-of-month callers contend from the same point; after
# release exactly one may reserve the sole 55-minute hold.
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_foundation_concurrency_setup.sql"
R1_FIFO="$(mktemp -u)"; mkfifo "$R1_FIFO"; R1_OUT="$(mktemp)"
docker exec -i -e PGAPPNAME=r1-race-blocker "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$R1_FIFO" >/dev/null 2>&1 &
exec 9>"$R1_FIFO"
printf "begin; select * from screening_v2.r1_settings where singleton for update;\n" >&9
for _ in $(seq 1 100); do
  [ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name='r1-race-blocker' and state='idle in transaction'")" = 1 ] && break
  sleep .1
done
for n in 3 4; do
  docker exec -e "PGAPPNAME=r1-race-$n" "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c \
    "select screening_v2.r1_send_round('20000000-0000-4000-8000-00000000000$((n-2))'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, encode(sha256('r1-first-of-month-race-${n}'::bytea),'hex'), null, now() + interval '1 day')->>'status'" >> "$R1_OUT" 2>&1 &
done
for _ in $(seq 1 100); do
  [ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name like 'r1-race-%' and wait_event_type='Lock'")" = 2 ] && break
  sleep .1
done
[ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name like 'r1-race-%' and wait_event_type='Lock'")" = 2 ] \
  || { log 'ERROR: first-of-month racers did not block on admission locks'; exit 1; }
printf 'commit;\n' >&9; exec 9>&-; wait
[ "$(grep -c '^ok$' "$R1_OUT" || true)" = 1 ] && [ "$(grep -c '^capacity_exhausted$' "$R1_OUT" || true)" = 1 ] \
  || { log 'ERROR: first-of-month race results:'; cat "$R1_OUT"; exit 1; }

# Cancellation and the expiry sweep used to lock the round before the budget,
# while admission locked settings -> budget -> round.  These races block both
# callers on settings first, then release them together.  An old terminal path
# would take its round lock instead of blocking here, while an inversion after
# release would surface as a deadlock error rather than an allowed outcome.
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_foundation_transition_concurrency_setup.sql"

r1_terminal_race() {
  local label="$1" allowed_terminal="$2" terminal_sql round_id app_prefix
  round_id="$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c \
    "select round_id from _r1_race.fixtures where label='${label}'")"
  [ -n "$round_id" ] || { log "ERROR: missing ${label} race fixture"; return 1; }
  # A successful preceding admission owns the one-live-R1 slot.  Terminalize
  # it before the next independent race so both admission outcomes stay valid.
  docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c \
    "update screening_v2.call_sessions set status='failed', terminal_reason='provider_error' where interview_round_id is not null and status in ('created','waiting','in_progress');"
  if [ "$label" = 'cancel' ]; then
    terminal_sql="select 'terminal:' || (screening_v2.r1_transition_round('${round_id}'::uuid, 'cancel', (select version from screening_v2.interview_rounds where id='${round_id}'::uuid), null, null)->>'status')"
  else
    # The sweep also gives back the uncounted charge of the cancel fixture (0119), whose expires_at ties with
    # the expiry fixture's, so a limit of 1 could sweep either one. A wider limit always reaches the expiry
    # fixture; the sweep still takes the settings lock first, which is what this race proves.
    terminal_sql="select 'terminal:' || screening_v2.r1_sweep_expired_rounds(now()+interval '2 hours', 10)::text"
  fi
  app_prefix="r1-terminal-${label}"
  R1_FIFO="$(mktemp -u)"; mkfifo "$R1_FIFO"; R1_OUT="$(mktemp)"
  docker exec -i -e PGAPPNAME="${app_prefix}-blocker" "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$R1_FIFO" >/dev/null 2>&1 &
  exec 9>"$R1_FIFO"
  printf "begin; select * from screening_v2.r1_settings where singleton for update;\n" >&9
  for _ in $(seq 1 100); do
    [ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name='${app_prefix}-blocker' and state='idle in transaction'")" = 1 ] && break
    sleep .1
  done
  docker exec -e "PGAPPNAME=${app_prefix}-admit" "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c \
    "select 'admit:' || (screening_v2.r1_admit_attempt('${round_id}'::uuid, repeat('e',64))->>'status')" >> "$R1_OUT" 2>&1 &
  docker exec -e "PGAPPNAME=${app_prefix}-terminal" "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c "$terminal_sql" >> "$R1_OUT" 2>&1 &
  for _ in $(seq 1 100); do
    [ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name like '${app_prefix}-%' and wait_event_type='Lock'")" = 2 ] && break
    sleep .1
  done
  [ "$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from pg_stat_activity where application_name like '${app_prefix}-%' and wait_event_type='Lock'")" = 2 ] \
    || { log "ERROR: ${label} racers did not both block on settings"; cat "$R1_OUT"; return 1; }
  printf 'commit;\n' >&9; exec 9>&-; wait
  grep -Eq '^admit:(ok|round_not_admissible)$' "$R1_OUT" \
    && grep -Eq "^terminal:(${allowed_terminal})$" "$R1_OUT" \
    || { log "ERROR: ${label} race results:"; cat "$R1_OUT"; return 1; }
  rm -f "$R1_FIFO" "$R1_OUT"; R1_FIFO=''; R1_OUT=''
  log "PASS: admission-vs-${label} race completed without deadlock"
}

r1_terminal_race 'cancel' 'ok|version_conflict'
r1_terminal_race 'expiry' '[0-9]+'

# 0120 (PR-3): preflight caps, attempt settlement (plan D1) and consent
# withdrawal. Deliberately LAST: it changes the R1 settings singleton and leaves
# live fixtures behind, and nothing above may depend on that state.
log 'Running R1 PR-3 candidate-route primitive assertions (0120)...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_candidate_routes_assert.sql"

log 'PASS: full-chain assertions, first-of-month capacity race, terminal transition races, and 0120 primitives'
