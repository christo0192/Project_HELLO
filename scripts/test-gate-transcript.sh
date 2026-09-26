#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for 0105's per-item gate transcript.
#
# WHY THIS EXISTS: 0105 re-declares `commit_phone_item_turn` so the worker can
# persist the pre-consent exchange AS IT HAPPENS, flagged `is_gate = true`. The
# one thing that must be proven by EXECUTION rather than by reading is that this
# does not open a consent bypass: 0070 derives `gate_recorded` from the very
# rows this writer now creates before consent, and the worker uses that flag to
# SKIP asking consent on a re-dispatched leg. The invariant that makes it safe —
# `get_phone_assessment_state` answers `plan_missing` before it ever derives
# `gate_recorded`, and a plan exists only after consent — lives in two functions
# written a year apart. Every vitest suite mocks Supabase; nothing else runs it.
#
# This spins a throwaway Postgres, applies EVERY migration in order, applies
# 0105 a second time to prove idempotency, then asserts by execution:
#   * the 0071 six-argument overload is GONE (two overloads would make PostgREST
#     refuse every call as ambiguous);
#   * `p_is_gate => true` writes `is_gate = true`; omitted writes false;
#   * a `waiting` session — the gate's state — accepts the write;
#   * dedup on `source_item_id` still converges;
#   * THE INVARIANT: gate rows with no plan ⇒ `plan_missing`, never `gate_recorded`;
#   * `commit_phone_gate_turns` answers `already_recorded` once per-item gate
#     rows exist, writing nothing (the once-writer stands down cleanly);
#   * the new signature carries the same posture as every other phone RPC.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${GATE_TRANSCRIPT_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="gate-transcript-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"

log() { printf '[gate-transcript] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

# Pull BEFORE the readiness clock starts. The sibling harnesses start their
# 60 x 1s wait immediately after `docker run`, so a slow image pull ate the
# whole budget and failed the job with "postgres never became ready" — three
# times on 2026-09-25 alone.
log "pulling ${IMAGE}..."
docker pull -q "$IMAGE" >/dev/null

log "starting ephemeral ${IMAGE}..."
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CTR" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$CTR" pg_isready -U postgres -q || { log 'ERROR: postgres never became ready.'; exit 1; }

# The roles every migration grants to. Supabase provides these; a bare
# Postgres does not, and a missing one fails the FIRST grant rather than the
# statement that actually matters.
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

log 'applying every migration in order...'
for f in "$MIG"/*.sql; do
  docker cp "$f" "$CTR:/tmp/$(basename "$f")" >/dev/null
  if ! docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
        -f "/tmp/$(basename "$f")" >/tmp/gt-migrate.log 2>&1; then
    log "ERROR: migration $(basename "$f") failed:"
    tail -30 /tmp/gt-migrate.log
    exit 1
  fi
done

log 'applying 0105 a second time (idempotency)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/0105_gate_transcript_per_item.sql >/dev/null

docker cp "$TESTS/gate_transcript_setup.sql" "$CTR:/tmp/setup.sql" >/dev/null
docker cp "$TESTS/gate_transcript_assert.sql" "$CTR:/tmp/assert.sql" >/dev/null

log 'seeding one call sitting in the gate...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/setup.sql

log 'asserting the writer, the overload, the once-writer, and the consent-skip invariant...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS'
