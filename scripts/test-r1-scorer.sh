#!/usr/bin/env bash
# R1 scorer assertions (migration 0122) run inside scripts/supabase-test.sh's already-started
# local Supabase stack. It has applied the complete 0001..0122 chain: never use stubs.
#
# Covers the audited status CAS (flag OFF by default, a human change after sending wins), the
# cancellable 24 h pending reject and its due sweep, the override monitor (>10% over a rolling
# 20 switches auto-status off), assessment attach/supersede idempotency, the R1-aware funnel
# views (R1 excluded from "latest assessment"; r1.* DLQ rows visible; phone rows unchanged),
# and the privileges/search_path posture of every new function.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly TESTS="app/supabase/tests"
log() { printf '[r1-scorer] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null \
  || { log "ERROR: expected Supabase database container $SUPABASE_DB_CONTAINER"; exit 1; }

log 'Running R1 scorer assertions against the complete 0001..0122 schema...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$TESTS/r1_scorer_assert.sql"

log 'PASS: R1 scorer status CAS, pending reject, override monitor, attach and funnel-view assertions'
