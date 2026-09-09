#!/usr/bin/env bash
# Isolated real-Postgres behavioral test for the 0090 funnel observability
# views + refresh RPC.
#
# WHY THIS EXISTS: the vitest suites mock Supabase and the migration test is
# pure SQL text-matching, so neither executes the views or
# refresh_funnel_rollup. A one-time "applied on a fixture" check is not a
# regression guard. This spins a throwaway PG17, bootstraps a FAITHFUL-MINIMAL
# screening_v2 schema (exactly the columns the views read — see
# funnel_views_bootstrap.sql), applies the ACTUAL committed 0090 migration, and
# drives fixtures + assertions through every view and the rollup RPC. It guards:
#   * the drop_reason bucketing, incl. the qualified-but-not-yet-reference-check
#     case that a review found mislabeled;
#   * failure-code sanitization (length-only Ashby codes -> 'other');
#   * the rollup counts and delete+insert idempotency / unique grain.
# It applies the real migration file, so it fails the moment the shipped
# view/RPC SQL regresses.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${FUNNEL_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="funnel-views-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations/0090_funnel_observability.sql"

log() { printf '[funnel-views] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
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
docker exec "$CTR" pg_isready -U postgres -q || { log 'ERROR: postgres never became ready.'; exit 1; }

docker cp "$TESTS/funnel_views_bootstrap.sql" "$CTR:/tmp/bootstrap.sql"
docker cp "$MIG" "$CTR:/tmp/0090.sql"
docker cp "$TESTS/funnel_views_assert.sql" "$CTR:/tmp/assert.sql"

log 'bootstrapping faithful-minimal screening_v2 schema...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null
log 'applying the real 0090 migration...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0090.sql >/dev/null
log 'running view + refresh_funnel_rollup assertions...'
docker exec "$CTR" psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS — funnel views + refresh_funnel_rollup behaviour verified on real Postgres.'
