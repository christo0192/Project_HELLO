#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for 0125 (M013 S02, PR-2): phone
# recording and call-record integrity.
#
# WHY THIS EXISTS: 0125 re-declares the trigger that computes a phone
# session's duration_sec, adds a room_name stamp trigger on
# phone_call_attempts, and BACKFILLS both over production history. Every
# vitest suite mocks Supabase, so the only place the new rule, the triggers
# and — above all — the backfills over rows written by the OLD rule can be
# proven is a real Postgres that has seen that history.
#
# So the order matters, and differs from the sibling harnesses:
#   1. apply every migration BEFORE 0125;
#   2. seed history under the OLD 0076 rule (phone_0125_setup.sql), including
#      the 9f60523d shape (timings only, synthetic ids) that 0076 turned into
#      443 s;
#   3. apply 0125, assert both backfills (phone_0125_backfill_assert.sql);
#   4. apply 0125 a SECOND time (idempotency), then any later migration;
#   5. assert no row changed on the second apply, the column CHECKs, the
#      exact attempt-trigger set, the room_name stamp and the new duration
#      rule on first completion (phone_0125_assert.sql);
#   6. replay the 9f60523d sequence against §4's partial-finalize reconnect
#      guard and the unobserved_disconnect label (phone_0125_finalize.sql);
#   7. continue that replay into §5's zero-answer relabel, and try every
#      shape the relabel exception must refuse (phone_0125_relabel.sql).
#
# If S01 (or anything else) merges a migration numbered 0125 first, this
# migration is renumbered; MIGRATION below is the one place to change.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly MIGRATION="0125"
readonly IMAGE="${PHONE_0125_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="phone-0125-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"

log() { printf '[phone-%s] %s %s\n' "$MIGRATION" "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

shopt -s nullglob
target=("$MIG/${MIGRATION}"_*.sql)
[ "${#target[@]}" -eq 1 ] || { log "ERROR: expected exactly one ${MIGRATION}_*.sql, found ${#target[@]}."; exit 1; }
readonly TARGET="${target[0]}"

# Pull BEFORE the readiness clock starts (see test-gate-transcript.sh: a slow
# pull ate the whole 60 s budget three times on 2026-09-25).
log "pulling ${IMAGE}..."
docker pull -q "$IMAGE" >/dev/null

log "starting ephemeral ${IMAGE}..."
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CTR" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$CTR" pg_isready -U postgres -q || { log 'ERROR: postgres never became ready.'; exit 1; }

# The roles every migration grants to, and the Supabase schemas a bare
# Postgres lacks — identical to the sibling harnesses.
log 'creating the Supabase roles the migrations grant to...'
docker exec -i "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
do $$
declare
  r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator',
                           'supabase_auth_admin','supabase_storage_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text
);
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000000ad', 'fixture-owner@example.test')
on conflict (id) do nothing;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text
);
alter table storage.objects enable row level security;
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
SQL

# One file, one transaction (-1), as `supabase db push` applies it, so a
# `set local` and a mid-file failure behave as they will in production.
apply() {
  local f="$1"
  docker cp "$f" "$CTR:/tmp/$(basename "$f")" >/dev/null
  if ! docker exec "$CTR" psql -U postgres -q -1 -v ON_ERROR_STOP=1 \
        -f "/tmp/$(basename "$f")" >/tmp/phone-0125-migrate.log 2>&1; then
    log "ERROR: $(basename "$f") failed:"
    tail -30 /tmp/phone-0125-migrate.log
    exit 1
  fi
}

run_sql() {
  docker cp "$TESTS/$1" "$CTR:/tmp/$1" >/dev/null
  docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f "/tmp/$1"
}

log "applying every migration before ${MIGRATION}..."
for f in "$MIG"/*.sql; do
  n="$(basename "$f")"
  [[ "${n:0:4}" < "$MIGRATION" ]] || continue
  apply "$f"
done

log 'seeding call history under the 0076 duration rule...'
run_sql phone_0125_setup.sql

log "applying $(basename "$TARGET")..."
apply "$TARGET"

log 'asserting the room_name and duration backfills...'
run_sql phone_0125_backfill_assert.sql

log "applying $(basename "$TARGET") a second time (idempotency)..."
apply "$TARGET"

log "applying every migration after ${MIGRATION}..."
for f in "$MIG"/*.sql; do
  n="$(basename "$f")"
  [[ "${n:0:4}" > "$MIGRATION" ]] || continue
  apply "$f"
done

log 'asserting idempotency, CHECKs, the trigger set, the stamp and the duration rule...'
run_sql phone_0125_assert.sql

log 'replaying the partial-finalize reconnect guard and the disconnect label (§4)...'
run_sql phone_0125_finalize.sql

log 'continuing the replay into the zero-answer relabel and its refusals (§5)...'
run_sql phone_0125_relabel.sql

log 'PASS'
