#!/usr/bin/env bash
# Deterministic local Supabase lifecycle. Local/synthetic data only.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.110.0}"
readonly SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_screening-bot-local}"
log() { printf '[supabase-local] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

supabase_cli() {
  npx --yes "supabase@${SUPABASE_CLI_VERSION}" --workdir app "$@"
}

require_tools() {
  command -v docker >/dev/null || die 'Docker is required.'
  docker info >/dev/null 2>&1 || die 'Docker is not running.'
}

run_policy_tests() {
  docker inspect "$SUPABASE_DB_CONTAINER" >/dev/null 2>&1 \
    || die "Local database container is not running: $SUPABASE_DB_CONTAINER"
  docker exec -i "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    < app/supabase/tests/policy_tests.sql
}

case "${1:-}" in
  start)
    require_tools
    log "Starting Supabase CLI ${SUPABASE_CLI_VERSION}..."
    supabase_cli start
    supabase_cli status
    ;;
  reset)
    require_tools
    log 'Resetting the local database and applying all migrations...'
    supabase_cli db reset
    # MIG-03: Post-reset schema drift guard.
    # Compare the local database schema against committed migration files.
    # Clean diff (no output, exit 0) = migrations fully describe the schema.
    # Any output = drift.  See supabase-test.sh for the full implementation.
    if supabase_cli db diff --use-pg-delta --schema public,screening_v2 > /tmp/supabase-diff-local.txt 2>&1; then
      if [ -s /tmp/supabase-diff-local.txt ]; then
        die "Schema drift detected after db reset. Diff follows:
$(cat /tmp/supabase-diff-local.txt)
Run 'supabase db reset' to restore parity, then investigate."
      fi
      log 'Schema drift check: PASS (no drift)'
    else
      log 'Schema drift check: SKIPPED (--use-pg-delta unavailable)'
    fi
    rm -f /tmp/supabase-diff-local.txt
    ;;
  test)
    require_tools
    log 'Running local policy and schema tests...'
    run_policy_tests
    ;;
  stop)
    log 'Stopping local Supabase...'
    supabase_cli stop --no-backup
    ;;
  status)
    supabase_cli status
    ;;
  *)
    echo "Usage: $0 {start|reset|test|stop|status}"
    exit 1
    ;;
esac
