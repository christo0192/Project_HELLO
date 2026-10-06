#!/usr/bin/env bash
# R1 assertions run inside scripts/supabase-test.sh's already-started local
# Supabase stack. It has applied the complete 0001..0117 chain: never use stubs.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-foundation] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { rm -f "${R1_FIFO:-}" "${R1_OUT:-}"; }
trap cleanup EXIT INT TERM

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 assertions against the complete 0001..0117 schema...'
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
    "select screening_v2.r1_admit_attempt('20000000-0000-4000-8000-00000000000${n}'::uuid, repeat('${n}',64))->>'status'" >> "$R1_OUT" 2>&1 &
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
log 'PASS: full-chain assertions and first-of-month capacity race'
