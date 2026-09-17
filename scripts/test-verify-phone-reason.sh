#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for 0099 `verify_candidate_phone`.
#
# WHY THIS EXISTS: migrations reach the database through the owner's
# `supabase db push`, and the vitest migration tests are pure SQL text-matching.
# Without this, 0099's first EXECUTION would be against production — inside a
# SECURITY DEFINER function, on the table whose `updated_at` orders the dial
# queue. Same reasoning, and the same shape, as scripts/test-funnel-views.sh.
#
# It spins a throwaway PG17, bootstraps exactly the objects
# `verify_candidate_phone` reads or writes (including the REAL transition
# trigger, because "this update is a no-op to the trigger" is one of the claims
# under test), applies the ACTUAL committed migration, and drives fixtures and
# assertions through it.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${FUNNEL_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="verify-phone-reason-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations/0099_verify_phone_clears_stale_reason.sql"

log() { printf '[verify-phone-reason] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

log "starting ephemeral ${IMAGE}..."
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CTR" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$CTR" pg_isready -U postgres -q || {
  log 'ERROR: postgres never became ready.'; exit 1; }

docker cp "$TESTS/verify_phone_reason_bootstrap.sql" "$CTR:/tmp/bootstrap.sql"
docker cp "$MIG" "$CTR:/tmp/0099.sql"
docker cp "$TESTS/verify_phone_reason_assert.sql" "$CTR:/tmp/assert.sql"

log 'bootstrapping faithful-minimal screening_v2 fixture...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null
log 'applying the real 0099 migration...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0099.sql >/dev/null
log 'running verify_candidate_phone assertions...'
docker exec "$CTR" psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'OK'
