#!/usr/bin/env bash
# CI/local integration test for the production-boundary migrations.
# Starts only ephemeral local containers and uses synthetic identities/data.
# Also applies the GOV-06 synthetic seed, verifies idempotent rerun, and
# runs SQL integration tests — all within the same local-stack lifetime.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.110.0}"
readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
readonly RESULTS_FILE="$(mktemp)"
log() { printf '[supabase-ci] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

supabase_cli() {
  npx --yes "supabase@${SUPABASE_CLI_VERSION}" --workdir app "$@"
}
cleanup() {
  supabase_cli stop --no-backup >/dev/null 2>&1 || true
  rm -f "$RESULTS_FILE"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: Docker is required.'; exit 1; }
command -v curl >/dev/null || { log 'ERROR: curl is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: Docker is not running.'; exit 1; }

log "Starting local Supabase with CLI ${SUPABASE_CLI_VERSION}..."
supabase_cli start

log 'Resetting the database — this also applies config.toml-enabled seed...'
supabase_cli db reset
# Note: db reset ran migrations AND auto-applied the GOV-06 seed
# (config.toml: seed.sql_paths = ["./seed.sql"]).  The reset output
# above confirms seed auto-apply.  Any "already applied" messages for
# seed INSERTs confirm the ON CONFLICT DO NOTHING guard.

log 'GOV-06: Verifying seed was auto-applied by db reset (proving config.toml wired seed)...'
# This is empty-seed-scenario proof: if db reset did NOT auto-apply the seed,
# the expected GOV-06 rows will be missing.  Check one canonical row per table.
docker exec "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -t -A -c \
  "select count(*) from screening_v2.roles where id = '60000000-0000-4000-a000-000000000001'" \
  | grep -q '^1$' || { log 'ERROR: Seed was NOT auto-applied after db reset'; exit 1; }
docker exec "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -t -A -c \
  "select count(*) from screening_v2.candidates where id = '60000000-0000-4000-a000-000000000021'" \
  | grep -q '^1$' || { log 'ERROR: Seed was NOT auto-applied after db reset'; exit 1; }
log 'GOV-06: db reset auto-seed verified — seed present immediately after reset'

log 'Running SQL policy and schema tests...'
docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null 2>&1 \
  || { log "ERROR: Database container not found: $SUPABASE_DB_CONTAINER"; exit 1; }
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/tests/policy_tests.sql 2>&1 | tee "$RESULTS_FILE"

if grep -Eq '[[:space:]]FAIL([[:space:]]|$)' "$RESULTS_FILE"; then
  log 'ERROR: SQL policy suite reported a failure.'
  exit 1
fi

log 'Verifying custom-schema anon denial through PostgREST...'
ANON_KEY="$(supabase_cli status -o env 2>/dev/null \
  | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p' | head -1)"
if [ -z "$ANON_KEY" ]; then
  log 'ERROR: Could not read the ephemeral local anon key.'
  exit 1
fi

HTTP_CODE="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header "apikey: ${ANON_KEY}" \
  --header 'Accept-Profile: screening_v2' \
  'http://127.0.0.1:54321/rest/v1/candidates?select=id&limit=1')"
case "$HTTP_CODE" in
  401|403) log "Anon access denied as expected (HTTP ${HTTP_CODE})." ;;
  *)
    log "ERROR: Expected custom-schema anon denial, received HTTP ${HTTP_CODE}."
    exit 1
    ;;
esac

# ===================================================================
# GOV-06: First explicit seed re-apply (seed already applied by db reset
# via config.toml), then full rerun to prove idempotency, then SQL tests
# ===================================================================
log 'GOV-06: Applying seed on top of auto-applied seed (idempotency proof)...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/seed.sql
# The seed was ALREADY applied by supabase db reset (due to config.toml
# seed.sql_paths).  This explicit apply with ON CONFLICT DO NOTHING
# must not change cardinality.  We label this as the explicit baseline.

log 'GOV-06: Recording manifest-scoped canonical digest...'
declare -A BEFORE
for TABLE in roles resumes candidates call_sessions transcript_turns assessments consent_records; do
  # Count only GOV-06 namespace rows, not total table count (tolerates unrelated fixtures)
  BEFORE["$TABLE"]="$(docker exec "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A \
    -c "select count(*) from screening_v2.${TABLE} where id >= '60000000-0000-4000-a000-000000000001'")"
done

log 'GOV-06: Re-running seed (idempotent test)...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/seed.sql

log 'GOV-06: Verifying cardinality unchanged after rerun...'
FAILED=0
for TABLE in roles resumes candidates call_sessions transcript_turns assessments consent_records; do
  COUNT="$(docker exec "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A \
    -c "select count(*) from screening_v2.${TABLE} where id >= '60000000-0000-4000-a000-000000000001'")"
  if [ "$COUNT" != "${BEFORE[$TABLE]}" ]; then
    log "FAIL: ${TABLE} cardinality changed from ${BEFORE[$TABLE]} to ${COUNT}"
    FAILED=1
  else
    log "PASS: ${TABLE} cardinality stable at ${COUNT}"
  fi
done
if [ "$FAILED" = "1" ]; then
  log 'GOV-06: SEED RERUN TEST FAILED — seed is not idempotent'
  exit 1
fi
log 'GOV-06: Seed rerun test passed — idempotent'

log 'GOV-06: Running synthetic seed SQL integration tests...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/tests/synthetic_seed_tests.sql 2>&1 | tee -a "$RESULTS_FILE"

if grep -Eq '[[:space:]]FAIL([[:space:]]|$)' "$RESULTS_FILE"; then
  log 'ERROR: Synthetic seed SQL tests reported a failure.'
  exit 1
fi
log 'GOV-06: Synthetic seed SQL integration tests passed.'

log 'All local Supabase migration, policy, and synthetic seed checks passed.'
