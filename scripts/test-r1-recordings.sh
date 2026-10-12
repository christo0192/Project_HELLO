#!/usr/bin/env bash
# R1 recording assertions (migration 0127) run inside scripts/supabase-test.sh's already-started
# local Supabase stack. It has applied the complete 0001..0127 chain: never use stubs.
#
# Covers the recordings table and its constraints (composite attempt FK, prefix and key checks,
# status/deleted pairing, report windows), the finalize enqueue (exactly one job on the transition
# into `finishing`, dedup scope), the consent-withdrawal erase enqueue (withdrawn and declined
# queue it, superseded never does), isolation from phone sessions and the legacy
# recording.finalize, the delete -> purge outbox (candidate/round cascades, tombstones excluded),
# r1_settings.recording_mode (defaults off, rejects values outside off|audio|av), and the
# RLS/privileges/search_path posture of both tables and all three trigger functions.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-recordings] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 recording assertions against the complete 0001..0127 schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_recordings_assert.sql"

log 'PASS: R1 recording constraints, finalize/erase/purge triggers, recording_mode and privilege assertions'
