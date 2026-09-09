#!/usr/bin/env bash
# Isolated real-Postgres behavioral test for the 0091 scorecard partial-scoring
# migration: the schema relax, the in-place recovery of historical
# incomplete_evidence rows, and the v_funnel_failures hard-failure branch.
#
# WHY THIS EXISTS: the vitest suites mock Supabase and the migration text test
# only string-matches, so neither executes the recovery UPDATE or the relaxed
# CHECK. This spins a throwaway PG17, bootstraps a FAITHFUL-MINIMAL screening_v2
# schema carrying the ORIGINAL 0088 shape CHECK plus a fixture that mirrors the
# production incident (assessment e333af5d: 3/5 metrics scored @3, weighted
# NULL, raw.recommendation='human_review') and an all-insufficient row, applies
# the ACTUAL committed 0091 migration, then asserts:
#   * the incident row is recovered to weighted 3.0 / overall 50 / 'hold' in BOTH
#     the columns AND `raw` (the payload the candidate card reads from);
#   * the all-insufficient row stays null (genuine human review — nothing to
#     renormalize; guards the "null only when NONE scored" branch);
#   * the relaxed chk_assessments_v2_shape accepts a partial incomplete_evidence
#     row yet still rejects a `complete` row with a null weighted score;
#   * v_funnel_failures surfaces both the soft incomplete_evidence rows and the
#     hard job_dlq scoring failures, with codes sanitized and phone-scoped.
# It applies the real migration file, so it fails the moment the shipped
# recovery/CHECK/view SQL regresses.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${SCORECARD_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="scorecard-partial-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations/0091_scorecard_partial_scoring.sql"

log() { printf '[scorecard-partial] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
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

docker cp "$TESTS/scorecard_partial_bootstrap.sql" "$CTR:/tmp/bootstrap.sql"
docker cp "$MIG" "$CTR:/tmp/0091.sql"
docker cp "$TESTS/scorecard_partial_assert.sql" "$CTR:/tmp/assert.sql"

log 'bootstrapping faithful-minimal screening_v2 schema + incident fixture...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null
log 'applying the real 0091 migration (relax + recovery + funnel branch)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0091.sql >/dev/null
log 'running recovery + CHECK + funnel assertions...'
docker exec "$CTR" psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS — 0091 recovery, relaxed CHECK, and funnel hard-failure branch verified on real Postgres.'
