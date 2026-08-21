#!/usr/bin/env bash
# CI/local integration test for the production-boundary migrations.
# Starts only ephemeral local containers and uses synthetic identities/data.
# Also applies the GOV-06 synthetic seed, verifies idempotent rerun, and
# runs SQL integration tests — all within the same local-stack lifetime.
#
# Phase 6 lane L4 (TST-15): adds the migration rollback / compatibility gate.
# Supabase migrations are FORWARD-ONLY by strategy — no per-migration
# down-migration files exist for 0001-0013 and none are invented here (see
# docs/runbooks/supabase-migration-strategy.md "Rollback" and
# docs/runbooks/phase6-testing-ci.md). Rollback verification therefore =
#   (a) OFFLINE static half: contract-continuity + destructive-change
#       detector (scripts/migrate-rollback.test.mjs, run first, no DB);
#   (b) DYNAMIC half: CLEAN RESET / ROLL-FORWARD rehearsal (db reset applies
#       0001..0013 from pristine) + RESTORE rehearsal (a SECOND clean reset
#       reproduces an identical table/column/type inventory plus drift check).
# This proves the migration set can always be rebuilt from clean state — the
# sanctioned substitute for reverse SQL. Distinguish this from any claim of
# reverse-SQL rollback, which remains unsupported.
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

# ── TST-15 static half (offline; runs BEFORE any container is started) ──
log 'TST-15: Running offline migration rollback/compatibility verifier...'
node scripts/migrate-rollback.test.mjs

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

# ===================================================================
# MIG-03: Local drift/diff proof — verify schema matches migrations
# ===================================================================
# Drift check, factored so both MIG-03 (after first reset) and TST-15 (after
# the restore-rehearsal re-apply) can use it. Compare the local database
# schema against the committed migration files. On a clean database the
# pinned CLI still prints informational output ("No schema changes found"
# plus a JSON summary whose "diff" field is ""). Drift must therefore be
# detected from the actual diff PAYLOAD, not from the mere presence of
# output — otherwise a clean run is misread as drift. LOCAL-ONLY against
# an ephemeral container; never touches hosted/production.
check_no_drift() {
  local label="$1"
  log "${label}: Running local schema drift check (supabase db diff)..."
  if supabase_cli db diff --use-pg-delta --schema public,screening_v2 > /tmp/supabase-diff-output.txt 2>&1; then
    # Clean signals emitted by the pinned CLI when the schema matches migrations.
    if grep -qiE 'no schema changes found|"diff"[[:space:]]*:[[:space:]]*""' /tmp/supabase-diff-output.txt; then
      log "${label}: PASS — No schema drift. Local database matches migrations."
    else
      log "${label}: FAIL — Schema drift detected. Unexpected diff output follows:"
      cat /tmp/supabase-diff-output.txt
      log "${label}: This means the local database schema differs from the committed"
      log "${label}: migrations. Possible causes: manual DDL, uncommitted migration"
      log "${label}: changes, or shadow-database corruption. Run supabase db reset"
      log "${label}: to restore parity, then investigate the root cause."
      exit 1
    fi
  else
    # CLI does not support --use-pg-delta (e.g., older version, or the
    # pg-delta engine is not available on this platform). In CI mode
    # (GITHUB_ACTIONS=true or CI=true) this is a hard failure because the
    # drift gate cannot be verified; in local mode the skip is documented
    # and permitted.
    if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
      log "${label}: FAIL — supabase db diff --use-pg-delta unavailable in CI; drift gate cannot be verified"
      log "${label}: Reason: $(cat /tmp/supabase-diff-output.txt 2>/dev/null || echo 'non-zero exit from CLI')"
      exit 1
    fi
    log "${label}: SKIPPED — supabase db diff --use-pg-delta unavailable (local mode, documented)"
    log "${label}: Reason: $(cat /tmp/supabase-diff-output.txt 2>/dev/null || echo 'non-zero exit from CLI')"
  fi
  rm -f /tmp/supabase-diff-output.txt
}

check_no_drift 'MIG-03'


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

# ===================================================================
# 0040: GENUINELY CONCURRENT recovery race.
#
# `recover_ashby_ingestion_parse` now admits the ashby.ingestion job in
# its own transaction, so "two operators clicked retry at the same time"
# must charge one attempt, write one audit row and admit ONE job. The
# mechanism is a row lock on the application link, which by construction
# cannot be observed from a single session — so this fires three real,
# independent backends at one rested row and then asserts the durable
# consequences. Sequential proof of the same invariant lives in
# policy_tests.sql; this is the part that suite cannot express.
# ===================================================================
readonly POL40C_LINK='40000000-0000-4000-8000-0000000000c1'
readonly POL40C_ACTOR='00000000-0000-4000-8000-0000000000ad'

log '0040: Seeding the concurrent-recovery fixture...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/tests/recovery_concurrency_setup.sql

log '0040: Firing THREE concurrent recover_ashby_ingestion_parse calls...'
POL40C_OUT="$(mktemp)"
for _ in 1 2 3; do
  docker exec "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c \
    "select screening_v2.recover_ashby_ingestion_parse('${POL40C_LINK}'::uuid, '${POL40C_ACTOR}'::uuid)->>'status'" \
    >> "$POL40C_OUT" 2>&1 &
done
wait

POL40C_OK="$(grep -c '^ok$' "$POL40C_OUT" || true)"
POL40C_REFUSED="$(grep -c '^not_recoverable$' "$POL40C_OUT" || true)"
if [ "$POL40C_OK" != '1' ] || [ "$POL40C_REFUSED" != '2' ]; then
  log "ERROR: 0040 concurrency FAILED — expected 1 ok + 2 not_recoverable, got ok=${POL40C_OK} not_recoverable=${POL40C_REFUSED}"
  cat "$POL40C_OUT"
  rm -f "$POL40C_OUT"
  exit 1
fi
rm -f "$POL40C_OUT"
log '0040: One winner, two refusals — asserting the durable consequences...'
docker exec -i "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/tests/recovery_concurrency_assert.sql
log '0040: PASS — concurrent recoveries charge one attempt and admit exactly one job.'

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

# =====================================================================
# TST-15 rollback rehearsal — clean reset / roll-forward / restore
# (Phase 6 lane L4). No reverse SQL exists or is invented; this proves the
# sanctioned recovery path: the committed migration set can always be
# rebuilt from a pristine database with an identical schema and zero drift.
# =====================================================================

# Snapshot the post-reset schema inventory (tables + columns in the
# screening_v2 schema). Deterministic ordering via ORDER BY 1.
snapshot_schema() {
  docker exec "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c \
    "select n.nspname||'.'||c.relname||':'||a.attname||':'||a.atttypid::regtype::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'screening_v2'
        and c.relkind in ('r','p','v','m')
        and a.attnum > 0
        and not a.attisdropped
      order by 1"
}

log 'TST-15: Snapshotting schema inventory after the first clean reset (roll-forward baseline)...'
BEFORE_INVENTORY="$(snapshot_schema)"
log "TST-15: Baseline inventory lines: $(printf '%s\n' "$BEFORE_INVENTORY" | sed '/^$/d' | wc -l)"

log 'TST-15: RESTORE REHEARSAL — running a SECOND clean reset (db reset re-applies 0001..0013 + auto-seed from config.toml)...'
supabase_cli db reset

log 'TST-15: Verifying seed auto-applied by the second reset (restore parity)...'
docker exec "$SUPABASE_DB_CONTAINER" \
  psql -U postgres -d postgres -t -A -c \
  "select count(*) from screening_v2.roles where id = '60000000-0000-4000-a000-000000000001'" \
  | grep -q '^1$' || { log 'ERROR: Seed was NOT auto-applied after second reset'; exit 1; }
log 'TST-15: Seed present after second reset (roll-forward reproducible)'

log 'TST-15: Re-checking schema drift after the re-apply (must be clean)...'
check_no_drift 'TST-15'

log 'TST-15: Comparing schema inventory before/after the restore rehearsal...'
AFTER_INVENTORY="$(snapshot_schema)"
if [ "$BEFORE_INVENTORY" != "$AFTER_INVENTORY" ]; then
  log 'ERROR: TST-15 restore rehearsal FAILED — schema inventory differs between two clean resets.'
  diff <(printf '%s\n' "$BEFORE_INVENTORY") <(printf '%s\n' "$AFTER_INVENTORY") | head -40
  exit 1
fi
log "TST-15: PASS — restore rehearsal reproduced identical table/column/type inventory ($(printf '%s\n' "$AFTER_INVENTORY" | sed '/^$/d' | wc -l) inventory lines, zero drift)."
log 'TST-15: Rollback gate PASSED — forward-only migrations are contract-continuous, free of destructive DDL, and deterministically re-applicable from clean state.'

log 'All local Supabase migration, policy, synthetic seed, and TST-15 rollback rehearsal checks passed.'
