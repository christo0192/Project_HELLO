# GOV-06 Synthetic Demo Data Runbook

## Purpose

This runbook documents the deterministic, idempotent synthetic demo data
used for local Supabase rehearsal. It covers how the seed is applied,
verified, and removed in an ephemeral local stack.

## Constraints

1. **Synthetic-only**: All data uses the reserved UUID namespace
   `60000000-0000-4000-a000-XXXXXXXXXX` and the `@example.invalid` email
   domain (RFC-reserved, never routes). Phone fields are null (no phone
   numbers in seed). Names, companies, and text are clearly fictional with
   `SYNTHETIC DEMO` / `Synth Demo` / `Synthetic Demo` markers.
2. **No production exposure**: The seed is wired only through local
   `config.toml` (`seed.sql_paths`). Never apply to production.
3. **Idempotent**: Every `INSERT` uses `ON CONFLICT (id) DO NOTHING`.
   Running the seed multiple times produces the exact same dataset.
4. **INSERT-only**: No `DELETE`, `UPDATE`, `TRUNCATE`, `DDL`, `DCL`,
   `DO`, `SELECT`, `WITH`, `COPY`, or `CALL` statements.
5. **Timestamps**: All fixed UTC (`'2026-01-15T*Z'`) — no `now()` /
   `CURRENT_TIMESTAMP` / relative intervals.

## Seed Data Overview

The seed creates 3 candidates across 3 synthetic demo roles and exactly
**2 completed-session assessments**:

| Role ID | Role | Candidate | Session Status | Candidate Status | Has Assessment |
|---|---|---|---|---|---|
| `...001` | Synthetic Demo Test Engineer | Synth Demo Candidate Alpha | completed | screened | Yes (ID 051, overall 82) |
| `...002` | Synthetic Demo Data Scientist | Synth Demo Candidate Beta | completed | screened | Yes (ID 052, overall 88) |
| `...003` | Synthetic Demo UX Designer | Synth Demo Candidate Gamma | in_progress | screening | **No** |

Each candidate has:
- A synthetic resume (text-only, `text_extracted` + `parsed JSON`, no file upload)
- A call session (browser mode, `pipecat` provider)
- Transcript turns (fictional neutral demo text, 5/6/2 per session)
- A completed session has an assessment following the TypeScript
  `Assessment` type shape (`app/api/src/lib/types.ts`)
- A consent record
- Fixed UTC timestamps (`2026-01-15`) — explicit `created_at` and
  `updated_at` on every row
- Phone fields are null
- Email uses RFC-reserved `@example.invalid` with `synth.` prefix
- Assessment JSON matches TypeScript types: sub-scores 0-10,
  overall_score 0-100, correct `communication`, `motivation`,
  `role_fit`, `tone`, `english`, `resume_conflicts` shapes with all
  required nested objects, arrays, and enum values

Dataset version marker: `synthetic_dataset_version=gov-06-synthetic-v1`
(in file header comment).

## Apply

### Via `supabase db reset` (preferred)

```bash
cd app
npx supabase db reset
```

This runs migrations, then auto-applies the seed via `config.toml`
(`seed.sql_paths = ["./seed.sql"]`).

### Via `docker exec` (second apply / debugging)

```bash
docker exec -i supabase_db_screening-bot-local \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/seed.sql
```

## Verify

### Offline validator (no database required)

```bash
node scripts/check-synthetic-seed.mjs
```

Exit codes: 0 = pass, 1 = failure, 2 = error reading seed file.
All diagnostics emit only category codes (E001–E033) — never the
triggering data values, paths, or tokens.

### Offline mutation self-tests (no database, zero network)

```bash
node scripts/check-synthetic-seed.test.mjs
```

Expected: **64+ tests** pass, zero fail, zero external network calls.

### SQL integration tests (local Supabase required)

```bash
docker exec -i supabase_db_screening-bot-local \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < app/supabase/tests/synthetic_seed_tests.sql
```

Expected: All checks PASS. Tests are manifest-scoped (only operate on
reserved GOV-06 IDs), tolerate unrelated rows, and use strict NULL-safe
predicates with `COALESCE` guards.

### Full CI

```bash
bash scripts/supabase-test.sh
```

Runs offline validator, mutation tests, shell/whitespace checks,
YAML validation, then (if Docker available) starts local stack, runs
reset (migrations + seed auto-apply), policy tests, explicit seed
re-apply (idempotent proof), rerun cardinality comparison, and SQL
integration tests.

## Components

| File | Purpose |
|---|---|
| `app/supabase/seed.sql` | Deterministic INSERT-only seed |
| `scripts/check-synthetic-seed.mjs` | Offline validator (no DB) |
| `scripts/check-synthetic-seed.test.mjs` | 64+ mutation self-tests |
| `app/supabase/tests/synthetic_seed_tests.sql` | SQL integration tests |
| `scripts/supabase-test.sh` | All-in-one CI script |
| `docs/runbooks/synthetic-demo-data.md` | This runbook |

## Cleanup / Teardown

**Local CLI context only.**

### Non-destructive stop (preserves volumes for restart)

```bash
cd app && npx supabase stop
```

Stops containers but preserves Docker volumes.  Next `supabase start`
restores the database state (including seeded data).

### Destructive stop (removes all data)

```bash
cd app && npx supabase stop --no-backup
```

Stops containers and removes volumes.  Next `supabase start` creates a
fresh empty database; `supabase db reset` re-applies migrations + seed.

> `supabase stop` without `--no-backup` preserves volumes — it does NOT
> "destroy" them.  Use `--no-backup` for a truly clean teardown.

### Selective DELETE via exact ID list (not range)

To remove only synthetic rows without a full teardown — verify local
identity first:

```bash
# VERIFY: this is the LOCAL container, not production
# Check Docker project label, not just container name
docker inspect supabase_db_screening-bot-local \
  --format '{{.Config.Labels}}' | grep -q com.docker.compose.project=screening-bot-local \
  || { echo "ERROR: container is not the local Supabase stack"; exit 1; }

docker exec -i supabase_db_screening-bot-local \
  psql -U postgres -d postgres -c \
  "delete from screening_v2.consent_records where id in (
     '60000000-0000-4000-a000-000000000061',
     '60000000-0000-4000-a000-000000000062',
     '60000000-0000-4000-a000-000000000063'
   );
   delete from screening_v2.assessments where id in (
     '60000000-0000-4000-a000-000000000051',
     '60000000-0000-4000-a000-000000000052'
   );
   delete from screening_v2.transcript_turns where id in (
     '60000000-0000-4000-a000-000000000041',
     '60000000-0000-4000-a000-000000000042',
     '60000000-0000-4000-a000-000000000043',
     '60000000-0000-4000-a000-000000000044',
     '60000000-0000-4000-a000-000000000045',
     '60000000-0000-4000-a000-000000000046',
     '60000000-0000-4000-a000-000000000047',
     '60000000-0000-4000-a000-000000000048',
     '60000000-0000-4000-a000-000000000049',
     '60000000-0000-4000-a000-00000000004a',
     '60000000-0000-4000-a000-00000000004b',
     '60000000-0000-4000-a000-00000000004c',
     '60000000-0000-4000-a000-00000000004d'
   );
   delete from screening_v2.call_sessions where id in (
     '60000000-0000-4000-a000-000000000031',
     '60000000-0000-4000-a000-000000000032',
     '60000000-0000-4000-a000-000000000033'
   );
   delete from screening_v2.candidates where id in (
     '60000000-0000-4000-a000-000000000021',
     '60000000-0000-4000-a000-000000000022',
     '60000000-0000-4000-a000-000000000023'
   );
   delete from screening_v2.resumes where id in (
     '60000000-0000-4000-a000-000000000011',
     '60000000-0000-4000-a000-000000000012',
     '60000000-0000-4000-a000-000000000013'
   );
   delete from screening_v2.roles where id in (
     '60000000-0000-4000-a000-000000000001',
     '60000000-0000-4000-a000-000000000002',
     '60000000-0000-4000-a000-000000000003'
   );"
# Verify
docker exec -i supabase_db_screening-bot-local \
  psql -U postgres -d postgres -t -A -c \
  "select count(*) from screening_v2.roles where id in (
     '60000000-0000-4000-a000-000000000001',
     '60000000-0000-4000-a000-000000000002',
     '60000000-0000-4000-a000-000000000003'
   )"
# Should print 0
```

> ⚠️ Uses `IN (exact ids...)` rather than `BETWEEN` to avoid catching
> unknown rows that happen to fall in the same UUID range.

## Limitations

- **No storage bucket seeding**: `resumes_v2` and `recordings_v2` files
  are not uploaded — manual synthetic test-file upload required.
- **Call queue / SMS / ATS sync not seeded**: These trigger external
  integrations and are gated behind other milestones.
- **No production-safe apply wrapper exists**: Apply only via local
  `config.toml` wiring or `docker exec psql` against an ephemeral local
  stack. The seed has no `current_database()` guard because hosted
  Supabase also uses `postgres` as database name.
- **Seed auto-applies during `supabase db reset`**: The shell CI script
  verifies auto-seed immediately after reset (proving config.toml wiring),
  then explicitly re-applies for idempotency proof.
- **`supabase stop` without `--no-backup` preserves volumes**: Use
  `supabase stop --no-backup` for complete destructive teardown.
  The `docker compose down -v` variant is not documented here because
  the compose context is managed by the Supabase CLI, not the user.
