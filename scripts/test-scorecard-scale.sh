#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for the 0093 rubric rescale (1–5 → 1–4).
#
# WHY THIS EXISTS: the vitest suites mock Supabase, so nothing else executes this
# migration's data movement — and that movement is the risky part. 0093 must
# create a NEW immutable scorecard version per role rather than editing the one
# historical assessments were scored against (0088 blocks that with a trigger,
# and an earlier draft of this migration was caught failing on exactly that).
# This spins a throwaway Postgres, applies the REAL 0088 + 0089 + 0093 files,
# applies 0093 a SECOND time to prove idempotency, then asserts:
#   * the already-scored version is untouched and still five-level;
#   * a new four-level version exists, carries all five metrics, and is active;
#   * the rubric text mapped {1: old1, 2: old3, 3: old4, 4: old5};
#   * the second apply created no third version and bumped the library once;
#   * a pre-0093 assessment keeps its 1–5 score, its snapshot, and is tagged
#     score_scale_max = 5, while new rows default to 4;
#   * five-level rubrics are refused for new configurations and a weighted score
#     above a row's own scale is refused.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${SCORECARD_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="scorecard-scale-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"

log() { printf '[scorecard-scale] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
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

docker cp "$TESTS/scorecard_scale_bootstrap.sql" "$CTR:/tmp/bootstrap.sql"
docker cp "$MIG/0088_role_scorecards.sql" "$CTR:/tmp/0088.sql"
docker cp "$MIG/0089_scorecard_default_metrics.sql" "$CTR:/tmp/0089.sql"
docker cp "$MIG/0093_scorecard_scale_1_4.sql" "$CTR:/tmp/0093.sql"
docker cp "$TESTS/scorecard_scale_assert.sql" "$CTR:/tmp/assert.sql"

log 'bootstrapping faithful-minimal screening_v2 schema...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null
log 'applying the real 0088 + 0089 (five-level rubric world)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0088.sql >/dev/null
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0089.sql >/dev/null

log 'seeding a pre-0093 assessment scored on 1-5 and pinning the active version...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -c "
insert into screening_v2.assessments
  (schema_version, metric_results, weighted_score_5, scoring_status, overall_score, recommendation, scorecard_version_id)
select 2, '[]'::jsonb, 4.6, 'complete', 90, 'advance', r.active_scorecard_version_id
from screening_v2.roles r;
create table public.pin_old_version as
select active_scorecard_version_id as id from screening_v2.roles limit 1;" >/dev/null

log 'applying the real 0093 migration...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0093.sql >/dev/null
log 'applying 0093 a SECOND time (deploys re-run migrations)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0093.sql >/dev/null

log 'running rescale assertions...'
docker exec "$CTR" psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS — 0093 rescale verified on real Postgres.'
