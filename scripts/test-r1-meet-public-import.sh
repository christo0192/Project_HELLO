#!/usr/bin/env bash
# R1 over Google Meet public booking assertions (migration 0144, M035 S12) run inside
# scripts/supabase-test.sh's already-started local Supabase stack. It has applied the complete
# migration chain: never use stubs.
#
# Covers the r1_public_booking intake (the CHECK and the intake lock), the BEFORE INSERT guards on
# phone_engagements and ashby_resume_ingestions (directly and through advance_ashby_ingestion,
# apply_ashby_candidate_profile and ensure_ashby_phone_engagement), the claim_ashby_profile_due
# fence with the 0130 arms as regressions, v_ashby_application_impact and impact_application_rows
# leaving an import out, the read-only r1_meet_public_local_rows lookup, and the
# r1_meet_public_import_application RPC (validation, holds over the Ashby person, adoption of an
# existing link, the mapping, the exact link and shell it writes, nothing else written, and the
# privilege posture). The whole file runs in one transaction and is rolled back.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-meet-public-import] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 Meet public import assertions against the complete schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_meet_public_import_assert.sql"

log 'PASS: R1 Meet public import intake, fences, profile claim, impact view, local lookup and import RPC assertions'
