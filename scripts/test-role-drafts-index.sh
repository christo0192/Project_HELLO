#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for 0101's `uq_role_drafts_owner_running`.
#
# WHY THIS EXISTS: every vitest suite mocks Supabase, so nothing else executes
# this migration. The partial unique index is the ONLY admission control on Ask
# Hello — one press detaches up to six DeepSeek v4-pro calls, and the API layer
# states plainly that "a SELECT-then-INSERT cannot [enforce the cap], because a
# concurrent request sees the same empty result". Before this script the
# `create unique index` line could be deleted with the whole JS/TS suite green.
#
# This spins a throwaway Postgres, applies the REAL 0101 file, applies it a
# SECOND time to prove idempotency, then asserts by execution:
#   * the index exists, is UNIQUE, and is PARTIAL on status = 'running';
#   * a second `running` draft for the same owner raises 23505 — the exact code
#     `startRoleDraft` branches on;
#   * cancelled, succeeded and failed rows do NOT block the next start, which
#     is the permanent per-owner lockout a review already found once;
#   * the cap is per owner, not global;
#   * RLS is on with zero policies, anon/authenticated/public hold no grants,
#     and service_role can still write.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${ROLE_DRAFTS_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="role-drafts-index-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"

log() { printf '[role-drafts] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
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

docker cp "$TESTS/role_drafts_bootstrap.sql" "$CTR:/tmp/bootstrap.sql"
docker cp "$MIG/0101_role_drafts.sql" "$CTR:/tmp/0101.sql"
docker cp "$TESTS/role_drafts_assert.sql" "$CTR:/tmp/assert.sql"

log 'bootstrapping the roles and schema 0101 references...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null
log 'applying the real 0101...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0101.sql >/dev/null
log 'applying 0101 a second time (idempotency)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/0101.sql >/dev/null

log 'asserting the cap, the non-lockout, and the exposure posture...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS'
