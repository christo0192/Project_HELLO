#!/usr/bin/env bash
# Business-impact read model assertions (migration 0140, M031 S5) run inside
# scripts/supabase-test.sh's already-started local Supabase stack. It has applied
# the complete migration chain: never use stubs.
#
# Covers v_ashby_application_impact, impact_application_rows, impact_summary and
# impact_candidates on a fixture of 22 counted applications: nesting (no share
# over 100%), re-applications and re-screens, a job transfer, skipped and
# backward moves, archives from the Christy stage and after R1, provisional and
# held verdicts, browser_primary sessions and consent, the IST week edge, small
# n, progress off, a window nobody has read, the per-mapping switch, erased and
# restricted subjects (the erasure list, an already-terminal link included), a
# cohort, job or verdict row nobody has read yet, appeal blocks, and the list's
# visibility (D-M031-5). The whole file runs in one transaction and is rolled
# back.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[ashby-impact] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running business-impact read model assertions against the complete schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/ashby_impact_assert.sql"

log 'PASS: impact view, nested summary, candidate list visibility and the per-mapping switch'
