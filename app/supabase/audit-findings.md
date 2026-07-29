# Supabase Migration Audit — PR 1 Baseline

Date: 2026-07-28 | Branch: feat/mig-03-supabase-local-baseline

## Findings

### P0 — Unsafe anon grants & policies

| # | Finding | File | Impact |
|---|---------|------|--------|
| 1 | **Blanket anon read policies** (`using (true)`) on 5 tables exposing PII | `0002_realtime_rls.sql` | Anyone with anon key can read all candidates (name/email/phone), call sessions, transcripts, assessments, roles — no auth required |
| 2 | **`grant all privileges` to anon & authenticated** on all tables/sequences/functions | `0001_init.sql` | Combined with `alter default privileges`, this grants full INSERT/UPDATE/DELETE to anon/authenticated on any future table in `screening_v2`. RLS is deny-by-default today but a future table without RLS enabled would be fully open |
| 3 | **`alter default privileges ... grant all to anon, authenticated`** | `0001_init.sql` | Any new table/sequence/function in `screening_v2` automatically gets full anon/authenticated access. This is a ticking time bomb |
| 4 | **Realtime publication exposes PII tables to anon** | `0002_realtime_rls.sql` | Combined with anon read policies, realtime subscriptions leak live transcript/call data to anyone with the anon key |

### P1 — Schema gaps

| # | Finding | File |
|---|---------|------|
| 5 | `status` columns have no CHECK constraints — invalid values silently accepted | `0001_init.sql` (candidates, call_sessions, call_queue, sms_follow_ups, ats_sync_log) |
| 6 | `speaker` column in transcript_turns has no CHECK constraint — non-bot/non-candidate values silently accepted | `0001_init.sql` |
| 7 | `recommendation` column in assessments has no CHECK constraint | `0001_init.sql` |
| 8 | Missing unique constraint on `transcript_turns(session_id, turn_index)` — duplicate turns possible | `0001_init.sql` |
| 9 | Missing `updated_at` trigger on call_sessions, roles, resumes, assessments | `0001_init.sql` |
| 10 | No active recruiter-membership gate exists; a Supabase account alone must not imply organizational access | All migrations |
| 11 | Private bucket flags need explicit verification; direct browser policies must remain absent until authorized short-TTL API access exists | `0001_init.sql` |

### P2 — Compatibility risks

| # | Finding |
|---|---------|
| 12 | `alter publication supabase_realtime add table` assumes publication exists — fails silently on platforms where it doesn't |
| 13 | `create extension pgcrypto` requires superuser — unavailable on some Supabase plans |
| 14 | `notify pgrst, 'reload schema'` is Supabase-specific PostgREST — portability concern |

## Consumer inventory

| Consumer | Role | Tables accessed | Risk |
|----------|------|----------------|------|
| `app/api` (Express) | `service_role` | candidates, roles, call_sessions, transcript_turns, assessments, resumes | Bypasses RLS — correct for server but no application-level auth |
| `app/web` (React dashboard) | currently `anon` | call_sessions, transcript_turns, assessments, candidates (via Realtime) | Production-safe migrations intentionally block this prototype path until Supabase Auth integration exists |
| `app/voice-livekit` (Python worker) | `service_role` | transcript_turns, call_sessions | Bypasses RLS — correct for worker |

## Required hardening (this PR)

1. Remove blanket anon policies and broad browser-role grants from the fresh migration history.
2. Require both Supabase Auth and an active server-provisioned single-org recruiter membership.
3. Keep browser access read-only and limited to the five dashboard tables.
4. Keep resumes and recordings server-only until authorized short-TTL access is implemented.
5. Add and validate domain CHECK constraints and transcript position uniqueness.
6. Add `updated_at` triggers to mutable tables.
7. Exercise effective RLS with synthetic member, non-member, and revoked-member tests.
8. Preserve Realtime only for the three required dashboard streams under the same RLS gate.
