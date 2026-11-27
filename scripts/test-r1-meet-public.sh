#!/usr/bin/env bash
# R1 public Meet booking assertions (migration 0143, M035 S01) run inside scripts/supabase-test.sh's
# already-started local Supabase stack, right after the 0142 suite. It has applied the complete
# migration chain: never use stubs.
#
# Covers the r1_meet_bookings changes (source and the nullable Ashby ids, the calendar event id pin,
# the public columns, the 34 reasons and their pairing, the existing rows validating every swapped
# CHECK), the r1_meet_public_throttle table, the terminal and purge triggers with their exact
# r1-meet jobs (incl. the DSAR cascade beside the 0142 bot release), and the RLS/privileges/
# search_path posture. The whole file runs in one transaction and is rolled back.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-meet-public] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 public Meet booking assertions against the complete schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_meet_public_bookings_assert.sql"

log 'PASS: R1 public Meet bookings: source and ids, public columns, reasons, throttle table, terminal and purge triggers, privileges'
