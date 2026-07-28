#!/usr/bin/env bash
# =====================================================================
# supabase-local.sh — Deterministic local Supabase start/reset/test
#
# Prerequisites:
#   - Docker running
#   - supabase CLI installed: npm install supabase --save-dev
#   - Node.js >= 22
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

export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"

log()  { echo "[supabase-local] $(date -u +%H:%M:%S) $*"; }
die()  { log "ERROR: $*"; exit 1; }

# Symlink app/supabase -> supabase (CLI needs ./supabase/)
ensure_link() {
  if [ ! -L supabase ] && [ ! -d supabase ]; then
    ln -s app/supabase supabase
  fi
}

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
  ensure_link
  log "Starting local Supabase..."
  npx supabase start
  log "Local Supabase is running."
  npx supabase status
}

cmd_reset() {
  require_cli
  ensure_link
  log "Resetting local Supabase database (re-applies all migrations)..."
  npx supabase db reset
  log "Reset complete. All migrations re-applied."
}

cmd_test() {
  require_cli
  ensure_link
  log "Running policy tests..."
  PGPASSWORD=postgres psql \
    -h localhost -p 54322 -U postgres -d postgres \
    -f app/supabase/tests/policy_tests.sql \
    -v ON_ERROR_STOP=1
  log "Policy tests passed."
}

cmd_stop() {
  require_cli
  ensure_link
  log "Stopping local Supabase..."
  npx supabase stop
  log "Stopped."
}

cmd_status() {
  require_cli
  ensure_link
  npx supabase status
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
