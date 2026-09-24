#!/usr/bin/env bash
# Isolated real-Postgres behavioural test for 0103's per-candidate question set.
#
# WHY THIS EXISTS: 0103 REPLACES `start_phone_assessment`, the function that
# runs once per call, under lock, and whose output IS the conversation. Every
# vitest suite mocks Supabase, so nothing in the JS/TS world executes a line of
# it — the plan-selection block could be deleted with the whole suite green.
#
# This spins a throwaway Postgres, applies EVERY migration in order (0103's
# function depends on tables and enums from thirty of them), applies 0103 a
# second time to prove idempotency, then asserts by execution:
#   * `phone_normalize_question_plan` enforces exactly 0044's rules, including
#     that an unknown key like `category` is IGNORED rather than refused;
#   * a `ready` candidate set is preferred, and the plan says `candidate_resume`;
#   * absent / pending / failed / MALFORMED all fall back to the role template,
#     because a generator bug must never end a live call;
#   * an invalid ROLE template is still REFUSED, which 0044 chose deliberately
#     and 0103 must not have softened;
#   * the table's CHECKs and the widened plan-source constraint hold;
#   * deleting an engagement takes its generated questions with it.
set -euo pipefail
cd "$(dirname "$0")/.."

readonly IMAGE="${CANDIDATE_QUESTIONS_TEST_PG_IMAGE:-pgvector/pgvector:pg17}"
readonly CTR="candidate-questions-test-pg-$$"
readonly TESTS="app/supabase/tests"
readonly MIG="app/supabase/migrations"

log() { printf '[candidate-questions] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { log 'ERROR: docker is required.'; exit 1; }
docker info >/dev/null 2>&1 || { log 'ERROR: docker is not running.'; exit 1; }

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
-- `extensions` is where Supabase installs pgcrypto; `0089` and `0093` call
-- `extensions.digest` to derive a scorecard's configuration hash.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
-- `auth.users` is the FK target for `owner_id`, `created_by` and friends. Only
-- its primary key is ever referenced, so the primary key is the whole shape —
-- and the one row is the owner every fixture writes against.
create table if not exists auth.users (
  id uuid primary key,
  email text
);
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000000ad', 'fixture-owner@example.test')
on conflict (id) do nothing;
-- The two Supabase Storage relations `0001` writes a bucket row into and later
-- migrations drop policies from. Shapes only — nothing under test reads them,
-- and a full Storage install would drag in an extension this image lacks.
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
-- The Realtime publication `0002` adds tables to. Supabase ships it; a bare
-- Postgres does not.
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
        -f "/tmp/$(basename "$f")" >/tmp/cq-migrate.log 2>&1; then
    log "ERROR: migration $(basename "$f") failed:"
    tail -30 /tmp/cq-migrate.log
    exit 1
  fi
done

log 'applying 0103 a second time (idempotency)...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/0103_candidate_screening_questions.sql >/dev/null

docker cp "$TESTS/candidate_questions_setup.sql" "$CTR:/tmp/setup.sql" >/dev/null
docker cp "$TESTS/candidate_questions_assert.sql" "$CTR:/tmp/assert.sql" >/dev/null

log 'seeding six calls, one per candidate-set state...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/setup.sql

log 'asserting the preference, every fallback, and the refusal that must stay...'
docker exec "$CTR" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/assert.sql

log 'PASS'
