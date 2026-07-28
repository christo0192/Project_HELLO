# Migration Strategy — Supabase Production Baseline

Date: 2026-07-28 | Branch: feat/mig-03-supabase-local-baseline

## Decision: Fresh-baseline via hardening migration

**Chosen strategy**: Add migration `0004_hardening.sql` that runs after existing 0001-0003 to produce a deterministic hardened final state.

### Rationale

1. Existing dev projects already have 0001-0003 applied. Deleting or reordering would break them.
2. The new production project (MIG-01, not yet provisioned) will run all migrations in order and reach the same hardened final state.
3. A single hardening migration is atomic, auditable, and reversible (via `DROP` if needed in dev).

### What 0004 does

- **Drops** all blanket anon read policies (`using (true)`)
- **Revokes** `all privileges` from anon/authenticated on tables, sequences, functions
- **Revokes** `alter default privileges` for anon/authenticated
- **Grants** narrow `SELECT, INSERT, UPDATE, DELETE` to `authenticated` role only
- **Creates** authenticated-only RLS policies with owner-filtered access
- **Adds** CHECK constraints on status, speaker, recommendation columns
- **Adds** unique constraint on transcript_turns(session_id, turn_index)
- **Adds** updated_at triggers to all mutable tables
- **Adds** storage RLS policies for private buckets
- **Removes** Realtime tables from publication (gated behind authenticated access)

### Final state guarantees

- `anon` role: zero access to any screening_v2 table (no policies = deny-by-default)
- `authenticated` role: single-org read access to all tables (recruiter dashboard); write access to own records
- `service_role` role: full access (backend API, voice worker) — unchanged
- No blanket `using (true)` policies anywhere
- Realtime subscriptions require authentication
- Storage buckets require authentication for read/write

### Not in scope (this PR)

- Multi-org tenancy (`org_id` filtering) — single-org launch per alignment
- Recruiter RBAC (admin/interviewer/viewer) — application-layer concern
- Application auth UI/API — Phase 1 SEC-01/02
- Production project provisioning — MIG-01/02
