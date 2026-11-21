#!/usr/bin/env bash
# R1 over Google Meet assertions (migration 0142, M034 S02) run inside scripts/supabase-test.sh's
# already-started local Supabase stack. It has applied the complete migration chain: never use stubs.
#
# Covers the r1_meet_bookings and r1_meet_receipts tables (closed status/reason machine and its
# pairing, Meet URL, slot, bot and ticket bindings, unique event / live round / bot / ticket digest,
# receipt dedupe keys incl. the longest S01 Ashby form), interview_rounds.channel and its
# browser -> meet lock, the HR-attested consent columns and their pairing (the browser grant,
# decline, supersede and withdraw shapes unchanged), the candidate/round/session cascades and the
# r1-meet bot_release job, and the RLS/privileges/search_path posture. The whole file runs in one
# transaction and is rolled back.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-meet] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 Meet booking assertions against the complete schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_meet_bookings_assert.sql"

log 'PASS: R1 Meet bookings, receipts, round channel, HR-attested consent, cascades and privilege assertions'
