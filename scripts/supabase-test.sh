#!/usr/bin/env bash
# CI/local integration test for the production-boundary migrations.
# Starts only ephemeral local containers and uses synthetic identities/data.
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

log 'Resetting the database and applying migrations...'
supabase_cli db reset

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

log 'All local Supabase migration and policy checks passed.'
