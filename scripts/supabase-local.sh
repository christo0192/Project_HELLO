#!/usr/bin/env bash
# =====================================================================
# supabase-local.sh — Deterministic local Supabase start/reset/test
#
# Prerequisites:
#   - Docker running
#   - supabase CLI installed (https://supabase.com/docs/guides/cli)
#   - Node.js >= 22 (for npx supabase)
#
# Usage:
#   scripts/supabase-local.sh start    — start local Supabase
#   scripts/supabase-local.sh reset    — reset database + re-apply migrations
#   scripts/supabase-local.sh test     — run policy tests (requires running DB)
#   scripts/supabase-local.sh stop     — stop local Supabase
#   scripts/supabase-local.sh status   — show running services
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SUPABASE_DIR="app/supabase"
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"

log()  { echo "[supabase-local] $(date -u +%H:%M:%S) $*"; }
die()  { log "ERROR: $*"; exit 1; }

require_cli() {
  if ! npx supabase --version >/dev/null 2>&1; then
    die "supabase CLI not found. Install: npm install supabase --save-dev"
  fi
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    die "Docker is not running. Start Docker and retry."
  fi
}

cmd_start() {
  require_cli
  require_docker
  log "Starting local Supabase..."
  npx supabase start --workdir "$SUPABASE_DIR"
  log "Local Supabase is running."
  npx supabase status --workdir "$SUPABASE_DIR"
}

cmd_reset() {
  require_cli
  log "Resetting local Supabase database (re-applies all migrations)..."
  npx supabase db reset --workdir "$SUPABASE_DIR"
  log "Reset complete. All migrations re-applied."
}

cmd_test() {
  require_cli
  log "Running policy tests..."
  # Run the test migration against the local DB
  npx supabase db test --workdir "$SUPABASE_DIR" 2>/dev/null || {
    # Fallback: run test SQL directly via psql
    log "Running policy tests via local PG connection..."
    PGPASSWORD=postgres psql \
      -h localhost -p 54322 -U postgres -d postgres \
      -f "$SUPABASE_DIR/migrations/0005_policy_tests.sql" \
      -v ON_ERROR_STOP=1
  }
  log "Policy tests passed."
}

cmd_stop() {
  require_cli
  log "Stopping local Supabase..."
  npx supabase stop --workdir "$SUPABASE_DIR"
  log "Stopped."
}

cmd_status() {
  require_cli
  npx supabase status --workdir "$SUPABASE_DIR"
}

case "${1:-}" in
  start)  cmd_start ;;
  reset)  cmd_reset ;;
  test)   cmd_test ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 {start|reset|test|stop|status}"
    echo ""
    echo "  start   Start local Supabase (Docker)"
    echo "  reset   Reset database and re-apply all migrations"
    echo "  test    Run policy constraint tests against local DB"
    echo "  stop    Stop local Supabase"
    echo "  status  Show running services"
    exit 1
    ;;
esac
