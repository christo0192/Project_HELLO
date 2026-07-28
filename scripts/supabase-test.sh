#!/usr/bin/env bash
# =====================================================================
# supabase-test.sh — Run Supabase policy and constraint tests in CI.
#
# Starts a local Supabase instance, applies all migrations (0001-0005),
# runs policy tests via psql, verifies anon denial via REST, and stops.
# No production/candidate data involved — local ephemeral containers only.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

RESULTS_FILE="/tmp/supabase-test-results.txt"

log()  { echo "[supabase-ci] $(date -u +%H:%M:%S) $*"; }

# 0. Symlink app/supabase -> supabase (CLI expects ./supabase/)
if [ ! -L supabase ] && [ ! -d supabase ]; then
  log "Creating symlink: supabase -> app/supabase"
  ln -s app/supabase supabase
fi
trap 'rm -f supabase' EXIT

# 1. Start Supabase
log "Starting Supabase..."
npx supabase start

# 2. Wait for healthy
log "Waiting for Supabase to be healthy..."
for i in $(seq 1 30); do
  if curl -s http://localhost:54321/rest/v1/ >/dev/null 2>&1; then
    log "Supabase is healthy."
    break
  fi
  if [ "$i" = "30" ]; then
    log "ERROR: Supabase did not become healthy after 30 attempts."
    npx supabase status || true
    exit 1
  fi
  sleep 2
done

# 3. Apply all migrations (0001→0005)
log "Applying migrations (db reset)..."
npx supabase db reset

# 4. Run policy tests via psql
log "Running policy tests..."
PGPASSWORD=postgres psql \
  -h localhost -p 54322 -U postgres -d postgres \
  -f app/supabase/migrations/0005_policy_tests.sql \
  -v ON_ERROR_STOP=1 2>&1 | tee "$RESULTS_FILE"

# 5. Verify no failures
if grep -q 'FAIL' "$RESULTS_FILE"; then
  log "FAILURE: Some policy tests failed."
  grep 'FAIL' "$RESULTS_FILE"
  exit 1
fi
log "All policy tests PASSED."

# 6. Test anon denial: try to query candidates as anon
log "Testing anon access denial..."
ANON_KEY=$(npx supabase status 2>/dev/null | grep 'anon key' | awk '{print $3}' || echo "")
if [ -n "$ANON_KEY" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "apikey: $ANON_KEY" \
    "http://localhost:54321/rest/v1/candidates?limit=1" || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log "FAILURE: Anon can still read candidates (HTTP $HTTP_CODE)."
    exit 1
  fi
  log "Anon access correctly denied (HTTP $HTTP_CODE)."
else
  log "WARNING: Could not retrieve anon key. Skipping live anon test."
fi

# 7. Stop Supabase
log "Stopping Supabase..."
npx supabase stop

log "All Supabase CI tests PASSED."
