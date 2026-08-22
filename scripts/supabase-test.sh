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
  # The 0040 race section registers its FIFO/result file here so an
  # interrupt mid-race cannot leak either.
  if declare -f pol40c_cleanup >/dev/null 2>&1; then pol40c_cleanup; fi
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
# 0040: DETERMINISTIC concurrent-recovery race.
#
# `recover_ashby_ingestion_parse` admits the ashby.ingestion job in its
# own transaction, so "two operators clicked retry at the same time"
# must charge ONE attempt, write ONE audit row and admit ONE job. The
# serialiser is a row lock on the application link (0040), and a row
# lock cannot be observed from a single session — policy_tests.sql can
# only prove the sequential outcome.
#
# So this does not *hope* for overlap between three racing processes,
# which at psql-startup timescales almost never happens and would make
# the whole check pass identically with no lock at all. Instead a
# BLOCKER session takes the link's row lock and HOLDS it open while the
# three recovery sessions are launched; the harness then waits until
# pg_stat_activity shows all three parked on `wait_event_type='Lock'`.
# That wait is the proof: if the recovery did not take the lock, the
# racers would sail past and the wait would time out, failing the run.
# Only then is the blocker committed, releasing three genuinely
# contending transactions at once.
#
# Two phases, because the RPC takes two row locks in a fixed order:
#   phase `link`      — blocker holds ashby_application_links
#   phase `ingestion` — blocker holds ashby_resume_ingestions
# Each proves its lock is really taken. Their relative ORDER (link
# first, matching cancel_ashby_application, so no deadlock-prone
# inversion exists) is proven separately and statically by the
# pg_get_functiondef assertion in policy_tests.sql.
#
# No sleep-based timing assumption anywhere: the blocker holds until it
# is explicitly told to commit over a FIFO, and every wait is a bounded
# poll that FAILS the run rather than continuing.
# ===================================================================
readonly POL40C_ACTOR='00000000-0000-4000-8000-0000000000ad'
readonly POL40C_POLL_TRIES=150      # x 0.2s = 30s ceiling per wait
POL40C_FIFO=''
POL40C_OUT=''

# Every temp artefact this section makes is registered for the EXIT trap,
# so an interrupt mid-race cannot leak a FIFO or a result file.
pol40c_cleanup() {
  [ -n "$POL40C_FIFO" ] && rm -f "$POL40C_FIFO"
  [ -n "$POL40C_OUT" ] && rm -f "$POL40C_OUT"
  return 0
}

pol40c_scalar() {
  docker exec -i "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -t -A -c "$1"
}

# Bounded poll. Returns non-zero (failing the run under `set -e`) rather
# than looping forever, so a missing lock is a FAILURE and never a hang.
pol40c_wait_until() {
  local what="$1" sql="$2" want="$3" i
  for i in $(seq 1 "$POL40C_POLL_TRIES"); do
    if [ "$(pol40c_scalar "$sql")" = "$want" ]; then return 0; fi
    sleep 0.2
  done
  log "ERROR: 0040 concurrency FAILED — timed out waiting for ${what} (wanted ${want})"
  log "       pg_stat_activity snapshot follows:"
  pol40c_scalar "select application_name || ' | ' || state || ' | ' || coalesce(wait_event_type,'-')
                   from pg_stat_activity where application_name like 'pol40c-%'"
  return 1
}

# $1 = phase label, $2 = fixture link uuid, $3 = the row the blocker locks
# ('link' | 'ingestion'). Each phase uses its OWN link id: audit rows are
# append-only (0007), so reusing one would leave the previous phase's row
# behind and make "exactly one audit row" unassertable.
pol40c_race_phase() {
  local phase="$1" link="$2" target="$3" rpc="${4:-recover_ashby_ingestion_parse}" reason="${5:-parse_timeout}"
  local tag blocker_sql ok refused
  tag="pol40c-${phase}"

  case "$target" in
    link)
      blocker_sql="select id from screening_v2.ashby_application_links where id = '${link}'::uuid for update;" ;;
    ingestion)
      blocker_sql="select id from screening_v2.ashby_resume_ingestions where application_link_id = '${link}'::uuid for update;" ;;
    *)
      log "ERROR: 0040 concurrency: unknown blocker target ${target}"; return 1 ;;
  esac

  log "0040: Seeding the concurrent-recovery fixture (phase: ${phase})..."
  docker exec -i "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -v "link_id=${link}" -v "tag=${tag}" -v "reason=${reason}" \
    < app/supabase/tests/recovery_concurrency_setup.sql

  POL40C_FIFO="$(mktemp -u)"
  mkfifo "$POL40C_FIFO"
  POL40C_OUT="$(mktemp)"

  # ── Blocker: opens a transaction, takes the row lock, then waits for
  #    `commit` to arrive on the FIFO. It holds the lock for exactly as
  #    long as this harness wants it held.
  docker exec -i -e PGAPPNAME=pol40c-blocker "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$POL40C_FIFO" \
    > /dev/null 2>&1 &
  exec 9>"$POL40C_FIFO"
  printf 'begin;\n%s\n' "$blocker_sql" >&9

  # `idle in transaction` means the FOR UPDATE returned: the lock is held.
  pol40c_wait_until "the ${phase} blocker to hold its row lock" \
    "select count(*) from pg_stat_activity
      where application_name = 'pol40c-blocker' and state = 'idle in transaction'" '1'

  log "0040: Blocker holds the ${phase} row lock — launching three recovery sessions..."
  for i in 1 2 3; do
    docker exec -e "PGAPPNAME=pol40c-racer-${i}" "$SUPABASE_DB_CONTAINER" \
      psql -U postgres -d postgres -t -A -c \
      "select screening_v2.${rpc}('${link}'::uuid, '${POL40C_ACTOR}'::uuid)->>'status'" \
      >> "$POL40C_OUT" 2>&1 &
  done

  # THE PROOF. All three must be parked on a lock. Without the RPC's
  # `for update` on this table they would run straight through and this
  # wait would time out.
  pol40c_wait_until "all three recovery sessions to BLOCK on the ${phase} row lock" \
    "select count(*) from pg_stat_activity
      where application_name like 'pol40c-racer-%' and wait_event_type = 'Lock'" '3'
  log "0040: All three sessions are blocked on the ${phase} lock — releasing the blocker."

  printf 'commit;\n' >&9
  exec 9>&-
  wait

  ok="$(grep -c '^ok$' "$POL40C_OUT" || true)"
  refused="$(grep -c '^not_recoverable$' "$POL40C_OUT" || true)"
  if [ "$ok" != '1' ] || [ "$refused" != '2' ]; then
    log "ERROR: 0040 concurrency FAILED (phase ${phase}) — expected 1 ok + 2 not_recoverable, got ok=${ok} not_recoverable=${refused}"
    cat "$POL40C_OUT"
    return 1
  fi

  log "0040: phase ${phase} — one winner, two refusals. Asserting the durable consequences..."
  docker exec -i "$SUPABASE_DB_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -v "link_id=${link}" -v "tag=${tag}" -v "reason=${reason}" \
    < app/supabase/tests/recovery_concurrency_assert.sql

  pol40c_cleanup
  POL40C_FIFO=''
  POL40C_OUT=''
  log "0040: PASS — phase ${phase}: three CONTENDING recoveries charged one attempt and admitted exactly one job."
}

pol40c_race_phase 'link'      '40000000-0000-4000-8000-0000000000c1' 'link'
pol40c_race_phase 'ingestion' '40000000-0000-4000-8000-0000000000c2' 'ingestion'
# The 0041 one-shot door takes the SAME two locks in the SAME order, so it must
# serialise identically: one release, two refusals, one attempt, one audit row,
# one live job. Proven by contention, not by hoping three processes overlap.
pol40c_race_phase 'legacy'    '40000000-0000-4000-8000-0000000000c3' 'link' \
  'recover_ashby_legacy_bad_output' 'parse_bad_output'

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
