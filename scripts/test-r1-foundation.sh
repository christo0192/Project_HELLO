#!/usr/bin/env bash
# Real-Postgres execution proof for the isolated R1 foundation migrations.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${R1_FOUNDATION_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="r1-foundation-test-pg-$$"
readonly MIG="app/supabase/migrations"
readonly TESTS="app/supabase/tests"
readonly MONTH="$(date -u +%Y-%m-01)"
log() { printf '[r1-foundation] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; rm -f "${R1_FIFO:-}" "${R1_OUT:-}"; }
trap cleanup EXIT INT TERM
command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

docker run -d --name "$CTR" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$CTR" pg_isready -U postgres -q && break; sleep 1; done
docker exec "$CTR" pg_isready -U postgres -q || { log 'ERROR: postgres never became ready.'; exit 1; }

docker exec -i "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists pgcrypto;
create schema screening_v2;
create schema auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table screening_v2.roles (id uuid primary key, title text not null);
create table screening_v2.candidates (id uuid primary key, role_id uuid, name text);
create table screening_v2.assessments (id uuid primary key);
create table screening_v2.call_sessions (
  id uuid primary key default gen_random_uuid(), candidate_id uuid not null, role_id uuid,
  mode text not null default 'browser', provider text not null default 'livekit', external_call_id text,
  status text not null default 'created', owner_id uuid, started_at timestamptz not null default now()
);
create table screening_v2.transcript_turns (id uuid primary key default gen_random_uuid(), session_id uuid not null, turn_index integer not null, speaker text not null, text text not null);
create table screening_v2.job_queue (
  id uuid primary key default gen_random_uuid(), name text not null, payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending', dedup_key text, attempts integer not null default 0,
  max_attempts integer not null default 3
);
create unique index uq_job_queue_dedup_active on screening_v2.job_queue(dedup_key) where dedup_key is not null and status in ('pending','active','delayed');
create table screening_v2.audit_events (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null, actor_type text not null,
  action text not null, target_type text not null, target_id text not null, result text not null,
  metadata jsonb, created_at timestamptz not null default now()
);
create table screening_v2.ashby_job_mappings (
  id uuid primary key default gen_random_uuid(), external_job_id text not null unique, role_id uuid not null,
  owner_id uuid not null, ai_screening_stage_id text, ta_screening_stage_id text, status text not null default 'paused'
);
create role anon nologin; create role authenticated nologin; create role service_role nologin;
SQL

for f in "$MIG/0115_r1_round_foundation.sql" "$MIG/0116_r1_shared_session_fields.sql"; do
  docker cp "$f" "$CTR:/tmp/$(basename "$f")"
  docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f "/tmp/$(basename "$f")"
done
# New migrations are guarded so a local/rehearsal re-apply does not change the
# contract or fail before the behavioural assertions run.
for f in "$MIG/0115_r1_round_foundation.sql" "$MIG/0116_r1_shared_session_fields.sql"; do
  docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f "/tmp/$(basename "$f")"
done
docker cp "$TESTS/r1_foundation_assert.sql" "$CTR:/tmp/assert.sql"
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/assert.sql

# A blocker owns the month row while two admissions are launched. One racer waits
# directly on that row and the other waits behind the settings lock; release proves
# the row lock serialises capacity rather than allowing two 55-minute holds.
docker cp "$TESTS/r1_foundation_concurrency_setup.sql" "$CTR:/tmp/race.sql"
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/race.sql
R1_FIFO="$(mktemp -u)"; mkfifo "$R1_FIFO"; R1_OUT="$(mktemp)"
docker exec -i -e PGAPPNAME=r1-race-blocker "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 < "$R1_FIFO" >/dev/null 2>&1 &
exec 9>"$R1_FIFO"
printf "begin; select * from screening_v2.r1_budget_month where month_start = '%s'::date for update;\n" "$MONTH" >&9
for _ in $(seq 1 100); do
  [ "$(docker exec "$CTR" psql -U postgres -t -A -c "select count(*) from pg_stat_activity where application_name='r1-race-blocker' and state='idle in transaction'")" = 1 ] && break
  sleep .1
done
for n in 3 4; do
  docker exec -e "PGAPPNAME=r1-race-$n" "$CTR" psql -U postgres -t -A -c \
    "select screening_v2.r1_admit_attempt('20000000-0000-4000-8000-00000000000${n}'::uuid, repeat('${n}',64))->>'status'" >> "$R1_OUT" 2>&1 &
done
for _ in $(seq 1 100); do
  [ "$(docker exec "$CTR" psql -U postgres -t -A -c "select count(*) from pg_stat_activity where application_name like 'r1-race-%' and wait_event_type='Lock'")" = 2 ] && break
  sleep .1
done
[ "$(docker exec "$CTR" psql -U postgres -t -A -c "select count(*) from pg_stat_activity where application_name like 'r1-race-%' and wait_event_type='Lock'")" = 2 ] || { log 'ERROR: racers did not block on admission locks'; exit 1; }
printf 'commit;\n' >&9; exec 9>&-; wait
[ "$(grep -c '^ok$' "$R1_OUT" || true)" = 1 ] && [ "$(grep -c '^capacity_exhausted$' "$R1_OUT" || true)" = 1 ] || { log 'ERROR: race results:'; cat "$R1_OUT"; exit 1; }
log 'PASS'
